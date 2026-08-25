import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { IncomingHttpHeaders } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * node:fs/promises 部分 mock（与 hf/verify.test.ts 同款策略：vi.mock 工厂被提升到文件顶部，
 * 外部变量须经 vi.hoisted 引入）：mkdir/open 默认转发到真实实现，缺陷 #9b 用例按需覆写单次调用，
 * 模拟宿主目录不可写 / 写入中途磁盘写满等 errno 场景（本机是 root，真实只读目录不会触发 EACCES）。
 */
const { mkdirMock, openMock } = vi.hoisted(() => ({ mkdirMock: vi.fn(), openMock: vi.fn() }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  mkdirMock.mockImplementation(actual.mkdir);
  openMock.mockImplementation(actual.open);
  return { ...actual, mkdir: mkdirMock, open: openMock };
});

import {
  checkDiskSpace,
  DownloadError,
  isCanceledError,
  isPausedError,
  startDownload,
  type ProgressInfo,
} from "./downloader";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 轮询等待条件成立（超时抛错），用于等"下载真正开始"再触发 pause/cancel */
async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
    await delay(5);
  }
}

/** 测试服务器记录的请求（断言 Range/UA 等头部用） */
interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
}

/**
 * 本地静态文件服务器（node:http，随机端口）：
 * - 服务一个可整体替换的 Buffer 文件（换内容同时换 ETag，模拟源变更）
 * - HEAD 返回 Content-Length/ETag/Accept-Ranges；GET 解析 Range 头回 206 + Content-Range
 * - 可编程开关：interruptAfter（写 N 字节后 destroy socket 模拟断流）、ignoreRange（无视 Range 回 200 全量）、
 *   slow（分块延时写，给 pause/cancel 留时间窗）
 */
interface TestServer {
  fileUrl: string;
  setFile(buf: Buffer, etag: string): void;
  setInterruptAfter(bytes: number | null): void;
  setIgnoreRange(v: boolean): void;
  setSlow(chunkSize: number, delayMs: number | null): void;
  /** HEAD 响应的 Content-Length 单独造假（不影响 GET）：复现 #11 hf-mirror CDN 对 HEAD 回占位大小 */
  setHeadContentLengthOverride(n: number | null): void;
  /**
   * 只对"预检复核探针"（Range: bytes=0-0，即 downloader 的 recheckTotalViaRange）生效，
   * 其余 Range 请求（断点续传等）不受影响：
   * - "ignore"：当作无 Range，回 200 全量（模拟服务器不支持 Range）
   * - "416"：回 416 Range Not Satisfiable
   * - "unknown-total"：回 206 + Content-Range: bytes 0-0/*（总量未知）
   * - "kill"：直接断开 socket（模拟复核请求本身失败）
   */
  setRangeProbeBehavior(mode: "default" | "ignore" | "416" | "unknown-total" | "kill"): void;
  readonly requests: RecordedRequest[];
  getRequests(): RecordedRequest[];
  close(): Promise<void>;
}

function startTestServer(): Promise<TestServer> {
  let file: Buffer | null = null;
  let etag = "";
  let interruptAfter: number | null = null;
  let ignoreRange = false;
  let slow: { chunkSize: number; delayMs: number } | null = null;
  let headContentLengthOverride: number | null = null;
  let rangeProbeBehavior: "default" | "ignore" | "416" | "unknown-total" | "kill" = "default";
  const requests: RecordedRequest[] = [];
  const sockets = new Set<Socket>();

  const server = http.createServer((req, res) => {
    sockets.add(req.socket);
    requests.push({ method: req.method!, url: req.url!, headers: { ...req.headers } });

    if (!file) {
      res.writeHead(404).end();
      return;
    }
    if (req.method === "HEAD") {
      res.writeHead(200, {
        "Content-Length": String(headContentLengthOverride ?? file.length),
        ETag: etag,
        "Accept-Ranges": "bytes",
      });
      res.end();
      return;
    }

    // GET：解析 Range（bytes=N- 形式）；bytes=0-0 是 downloader 预检复核探针的固定形态
    let start = 0;
    let ranged = false;
    const rangeHeader = req.headers.range;
    const isRangeProbe = rangeHeader === "bytes=0-0";
    if (isRangeProbe && rangeProbeBehavior === "kill") {
      req.socket.destroy();
      return;
    }
    if (isRangeProbe && rangeProbeBehavior === "416") {
      res.writeHead(416, { "Content-Range": `bytes */${file.length}` }).end();
      return;
    }
    if (isRangeProbe && rangeProbeBehavior === "unknown-total") {
      res.writeHead(206, {
        "Content-Length": "1",
        "Content-Range": "bytes 0-0/*",
        "Accept-Ranges": "bytes",
        ETag: etag,
      });
      res.end(file.subarray(0, 1));
      return;
    }
    if (
      !ignoreRange &&
      !(isRangeProbe && rangeProbeBehavior === "ignore") &&
      typeof rangeHeader === "string"
    ) {
      const m = /^bytes=(\d+)-/.exec(rangeHeader);
      if (m) {
        start = Number(m[1]);
        ranged = true;
      }
    }
    if (ranged && start >= file.length) {
      res.writeHead(416, { "Content-Range": `bytes */${file.length}` }).end();
      return;
    }
    const slice = file.subarray(start);
    const headers: Record<string, string> = {
      "Content-Length": String(slice.length),
      "Accept-Ranges": "bytes",
      ETag: etag,
    };
    if (ranged) headers["Content-Range"] = `bytes ${start}-${file.length - 1}/${file.length}`;
    res.writeHead(ranged ? 206 : 200, headers);

    const writeAll = async (): Promise<void> => {
      if (slow) {
        for (let i = 0; i < slice.length; i += slow.chunkSize) {
          if (i > 0) await delay(slow.delayMs);
          const okToSend = res.write(slice.subarray(i, i + slow.chunkSize));
          if (!okToSend) await new Promise<void>((r2) => res.once("drain", () => r2()));
        }
        res.end();
      } else if (interruptAfter !== null) {
        // 中断模式：写 interruptAfter 字节（等 drain 落到内核）+ 短延时后 destroy，
        // 客户端 .part 确定性拿到 (0, interruptAfter] 字节
        const cut = Math.min(slice.length, interruptAfter);
        if (cut > 0) {
          const okToSend = res.write(slice.subarray(0, cut));
          if (!okToSend) await new Promise<void>((r2) => res.once("drain", () => r2()));
        }
        await delay(30);
        res.destroy();
      } else {
        res.end(slice);
      }
    };
    writeAll().catch(() => {
      try {
        res.destroy();
      } catch {
        /* 客户端已断开 */
      }
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        fileUrl: `http://127.0.0.1:${port}/file.bin`,
        setFile: (buf, e) => {
          file = buf;
          etag = e;
        },
        setInterruptAfter: (n) => (interruptAfter = n),
        setIgnoreRange: (v) => (ignoreRange = v),
        setSlow: (chunkSize, delayMs) => (slow = delayMs === null ? null : { chunkSize, delayMs }),
        setHeadContentLengthOverride: (n) => (headContentLengthOverride = n),
        setRangeProbeBehavior: (mode) => (rangeProbeBehavior = mode),
        requests,
        getRequests: () => requests.filter((r) => r.method === "GET"),
        close: () =>
          new Promise<void>((r2) => {
            for (const s of sockets) s.destroy();
            server.close(() => r2());
          }),
      });
    });
  });
}

describe("downloader（自研下载器）", () => {
  let server: TestServer;
  let tmp: string;
  let target: string;
  /** 每个用例独立的 2MB 随机文件与已知 sha256 */
  let file: Buffer;
  let fileSha: string;

  const partPath = () => target + ".part";
  const metaPath = () => target + ".part.meta.json";

  beforeEach(async () => {
    server = await startTestServer();
    file = randomBytes(2 * 1024 * 1024);
    fileSha = createHash("sha256").update(file).digest("hex");
    server.setFile(file, `"etag-${fileSha.slice(0, 12)}"`);
    tmp = mkdtempSync(path.join(tmpdir(), "llamapad-dl-"));
    target = path.join(tmp, "model.gguf");
  });

  afterEach(async () => {
    await server.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("全新下载：文件字节一致、sha256 match、resumedFrom=0、.part/.meta 清理", async () => {
    const result = await startDownload({
      url: server.fileUrl,
      targetPath: target,
      expectedSize: file.length,
      sha256: fileSha,
    }).result;

    expect(result.ok).toBe(true);
    expect(result.bytes).toBe(file.length);
    expect(result.sha256).toBe(fileSha);
    expect(result.sha256Verified).toBe("match");
    expect(result.resumedFrom).toBe(0);
    expect(readFileSync(target).equals(file)).toBe(true);
    expect(existsSync(partPath())).toBe(false);
    expect(existsSync(metaPath())).toBe(false);
  });

  it("进度回调：多次触发、downloaded 单调不减、total=2MB、bytesPerSec>0", async () => {
    const events: ProgressInfo[] = [];
    await startDownload(
      { url: server.fileUrl, targetPath: target, expectedSize: file.length, sha256: fileSha },
      (p) => events.push({ ...p }),
    ).result;

    expect(events.length).toBeGreaterThan(1);
    for (let i = 1; i < events.length; i++) {
      expect(events[i].downloaded).toBeGreaterThanOrEqual(events[i - 1].downloaded);
    }
    for (const e of events) {
      expect(e.total).toBe(file.length);
    }
    expect(events[events.length - 1].downloaded).toBe(file.length);
    expect(events.some((e) => e.bytesPerSec > 0)).toBe(true);
  });

  it("断点续传：中断后重试发 Range 头、追加写完成、resumedFrom>0", async () => {
    // 第一次：写一半断流 → result reject 网络错误，.part/.meta 保留
    server.setInterruptAfter(Math.floor(file.length / 2));
    const first = startDownload({
      url: server.fileUrl,
      targetPath: target,
      expectedSize: file.length,
      sha256: fileSha,
    });
    await expect(first.result).rejects.toThrow(/网络错误/);
    expect(existsSync(partPath())).toBe(true);
    expect(existsSync(metaPath())).toBe(true);
    const partSize = statSync(partPath()).size;
    expect(partSize).toBeGreaterThan(0);
    expect(partSize).toBeLessThan(file.length);
    const getsBeforeRetry = server.getRequests().length;

    // 第二次：同参数重调 → 续传
    server.setInterruptAfter(null);
    const result = await startDownload({
      url: server.fileUrl,
      targetPath: target,
      expectedSize: file.length,
      sha256: fileSha,
    }).result;

    // 重试的 GET 带 Range: bytes=<partSize>-，且只发了一次 GET
    const retryGets = server.getRequests().slice(getsBeforeRetry);
    expect(retryGets).toHaveLength(1);
    expect(retryGets[0].headers.range).toBe(`bytes=${partSize}-`);

    expect(result.resumedFrom).toBe(partSize);
    expect(result.ok).toBe(true);
    expect(result.bytes).toBe(file.length);
    expect(result.sha256Verified).toBe("match"); // 续传哈希 = 旧 .part 喂入 + 新字节增量
    expect(readFileSync(target).equals(file)).toBe(true);
    expect(existsSync(partPath())).toBe(false);
    expect(existsSync(metaPath())).toBe(false);
  });

  it("服务器忽略 Range（回 200 全量）：删 .part 重写，文件仍完整、resumedFrom=0", async () => {
    server.setInterruptAfter(Math.floor(file.length / 2));
    await expect(
      startDownload({ url: server.fileUrl, targetPath: target, expectedSize: file.length }).result,
    ).rejects.toThrow(/网络错误/);
    expect(existsSync(partPath())).toBe(true);
    const getsBeforeRetry = server.getRequests().length;

    server.setInterruptAfter(null);
    server.setIgnoreRange(true);
    const result = await startDownload({
      url: server.fileUrl,
      targetPath: target,
      expectedSize: file.length,
      sha256: fileSha,
    }).result;

    expect(result.resumedFrom).toBe(0);
    expect(result.bytes).toBe(file.length);
    expect(readFileSync(target).equals(file)).toBe(true);
    expect(server.getRequests().length).toBeGreaterThan(getsBeforeRetry);
  });

  it("ETag 变化：meta 不一致 → 从 0 重下（GET 不带 Range）、内容为新文件", async () => {
    // 第一次：拿到一半 .part（meta 记录旧 ETag）
    server.setInterruptAfter(Math.floor(file.length / 2));
    await expect(
      startDownload({ url: server.fileUrl, targetPath: target, expectedSize: file.length }).result,
    ).rejects.toThrow(/网络错误/);
    expect(existsSync(partPath())).toBe(true);

    // 服务器换内容 + 换 ETag（大小不变——只有 ETag 能发现源变了）
    const file2 = randomBytes(file.length);
    const file2Sha = createHash("sha256").update(file2).digest("hex");
    server.setFile(file2, `"etag-${file2Sha.slice(0, 12)}"`);
    server.setInterruptAfter(null);
    const getsBeforeRetry = server.getRequests().length;

    const result = await startDownload({
      url: server.fileUrl,
      targetPath: target,
      expectedSize: file2.length,
      sha256: file2Sha,
    }).result;

    expect(result.resumedFrom).toBe(0); // 不复用旧 .part
    const retryGets = server.getRequests().slice(getsBeforeRetry);
    expect(retryGets[0].headers.range).toBeUndefined(); // 从 0 重下，不发 Range
    expect(readFileSync(target).equals(file2)).toBe(true); // 旧字节没混进新文件
    expect(result.sha256Verified).toBe("match");
  });

  it("sha256 失败：期望值给错 → 抛含期望/实际的错误、.part 被删、不落位", async () => {
    const wrongSha = "0".repeat(64);
    const handle = startDownload({
      url: server.fileUrl,
      targetPath: target,
      expectedSize: file.length,
      sha256: wrongSha,
    });
    await expect(handle.result).rejects.toThrow(
      `sha256 校验失败：期望 ${wrongSha}，实际 ${fileSha}`,
    );
    expect(existsSync(partPath())).toBe(false);
    expect(existsSync(metaPath())).toBe(false);
    expect(existsSync(target)).toBe(false);
  });

  it("无 sha256：verified=skipped 正常落位，result.sha256 仍给出实际值", async () => {
    const result = await startDownload({
      url: server.fileUrl,
      targetPath: target,
      expectedSize: file.length,
    }).result;

    expect(result.ok).toBe(true);
    expect(result.sha256Verified).toBe("skipped");
    expect(result.sha256).toBe(fileSha);
    expect(readFileSync(target).equals(file)).toBe(true);
  });

  it("HEAD 预检：expectedSize 与 Content-Length 不符 → 抛错且不产生 .part", async () => {
    const handle = startDownload({
      url: server.fileUrl,
      targetPath: target,
      expectedSize: file.length + 12345,
      sha256: fileSha,
    });
    await expect(handle.result).rejects.toThrow(/源文件大小与预期不符/);
    expect(existsSync(partPath())).toBe(false);
    expect(existsSync(metaPath())).toBe(false);
    expect(existsSync(target)).toBe(false);
  });

  it("HEAD 对小文件返回占位 Content-Length（hf-mirror CDN 复现 #11）：Range 复核确认源未变，继续下载并成功", async () => {
    const small = randomBytes(757);
    const smallSha = createHash("sha256").update(small).digest("hex");
    server.setFile(small, `"etag-${smallSha.slice(0, 12)}"`);
    server.setHeadContentLengthOverride(20); // 真机实测：CDN 对 HEAD 回占位 20B，真实文件 757B

    const result = await startDownload({
      url: server.fileUrl,
      targetPath: target,
      expectedSize: small.length,
      sha256: smallSha,
    }).result;

    expect(result.ok).toBe(true);
    expect(result.bytes).toBe(small.length);
    expect(result.sha256).toBe(smallSha);
    expect(readFileSync(target).equals(small)).toBe(true);
  });

  it("HEAD 占位之外源真的变了：Range 复核确认新总量与预期不符 → 仍抛 SOURCE_CHANGED", async () => {
    const real = randomBytes(999);
    server.setFile(real, `"etag-real"`);
    server.setHeadContentLengthOverride(20); // HEAD 依旧占位，不代表真实大小

    const handle = startDownload({
      url: server.fileUrl,
      targetPath: target,
      expectedSize: 757, // 与 HEAD(20) 和真实(999) 都不同
    });
    await expect(handle.result).rejects.toThrow(/源文件大小与预期不符/);
    await expect(handle.result).rejects.toThrow(/999/); // 结论来自 Range 复核的真实总量，而非 HEAD 的占位值
    expect(existsSync(partPath())).toBe(false);
    expect(existsSync(metaPath())).toBe(false);
    expect(existsSync(target)).toBe(false);
  });

  it("Range 复核请求不被服务器支持（200 无 Content-Range）：放弃预检继续下载并成功", async () => {
    const small = randomBytes(757);
    const smallSha = createHash("sha256").update(small).digest("hex");
    server.setFile(small, `"etag-${smallSha.slice(0, 12)}"`);
    server.setHeadContentLengthOverride(20);
    server.setRangeProbeBehavior("ignore");

    const result = await startDownload({
      url: server.fileUrl,
      targetPath: target,
      expectedSize: small.length,
      sha256: smallSha,
    }).result;

    expect(result.ok).toBe(true);
    expect(readFileSync(target).equals(small)).toBe(true);
  });

  it("Range 复核请求得到 416：放弃预检继续下载并成功", async () => {
    const small = randomBytes(757);
    const smallSha = createHash("sha256").update(small).digest("hex");
    server.setFile(small, `"etag-${smallSha.slice(0, 12)}"`);
    server.setHeadContentLengthOverride(20);
    server.setRangeProbeBehavior("416");

    const result = await startDownload({
      url: server.fileUrl,
      targetPath: target,
      expectedSize: small.length,
      sha256: smallSha,
    }).result;

    expect(result.ok).toBe(true);
    expect(readFileSync(target).equals(small)).toBe(true);
  });

  it("Range 复核返回总量未知（Content-Range .../*）：放弃预检继续下载并成功", async () => {
    const small = randomBytes(757);
    const smallSha = createHash("sha256").update(small).digest("hex");
    server.setFile(small, `"etag-${smallSha.slice(0, 12)}"`);
    server.setHeadContentLengthOverride(20);
    server.setRangeProbeBehavior("unknown-total");

    const result = await startDownload({
      url: server.fileUrl,
      targetPath: target,
      expectedSize: small.length,
      sha256: smallSha,
    }).result;

    expect(result.ok).toBe(true);
    expect(readFileSync(target).equals(small)).toBe(true);
  });

  it("Range 复核请求本身失败（连接被重置）：放弃预检继续下载并成功", async () => {
    const small = randomBytes(757);
    const smallSha = createHash("sha256").update(small).digest("hex");
    server.setFile(small, `"etag-${smallSha.slice(0, 12)}"`);
    server.setHeadContentLengthOverride(20);
    server.setRangeProbeBehavior("kill");

    const result = await startDownload({
      url: server.fileUrl,
      targetPath: target,
      expectedSize: small.length,
      sha256: smallSha,
    }).result;

    expect(result.ok).toBe(true);
    expect(readFileSync(target).equals(small)).toBe(true);
  });

  it("HEAD 大小与 expectedSize 相符：不触发 Range 复核（无多余请求）", async () => {
    const result = await startDownload({
      url: server.fileUrl,
      targetPath: target,
      expectedSize: file.length,
      sha256: fileSha,
    }).result;

    expect(result.ok).toBe(true);
    expect(server.requests.some((r) => r.headers.range === "bytes=0-0")).toBe(false);
  });

  it("pause：下载中暂停 → .part/.meta 保留、result reject 可用 isPausedError 判别；恢复=重新调用（续传）", async () => {
    server.setSlow(64 * 1024, 15); // 分块慢发，留出暂停时间窗
    const events: ProgressInfo[] = [];
    const handle = startDownload(
      { url: server.fileUrl, targetPath: target, expectedSize: file.length, sha256: fileSha },
      (p) => events.push({ ...p }),
    );
    await waitFor(() => events.length > 0);
    handle.pause();

    let caught: unknown;
    try {
      await handle.result;
    } catch (e) {
      caught = e;
    }
    expect(isPausedError(caught)).toBe(true);
    expect((caught as Error).message).toBe("下载已暂停");
    const partSize = statSync(partPath()).size; // .part 保留（>0，首块已落）
    expect(partSize).toBeGreaterThan(0);
    expect(existsSync(metaPath())).toBe(true);
    expect(existsSync(target)).toBe(false);

    // 恢复 = 外部重新调用同参数：走 Range 续传并完成
    server.setSlow(64 * 1024, 0);
    const result = await startDownload({
      url: server.fileUrl,
      targetPath: target,
      expectedSize: file.length,
      sha256: fileSha,
    }).result;
    expect(result.resumedFrom).toBe(partSize);
    expect(readFileSync(target).equals(file)).toBe(true);
  });

  it("cancel：下载中取消 → .part/.meta 删除、result reject 可用 isCanceledError 判别", async () => {
    server.setSlow(64 * 1024, 15);
    const events: ProgressInfo[] = [];
    const handle = startDownload(
      { url: server.fileUrl, targetPath: target, expectedSize: file.length },
      (p) => events.push({ ...p }),
    );
    await waitFor(() => events.length > 0);
    await handle.cancel(); // cancel 等清理完成后才 resolve

    let caught: unknown;
    try {
      await handle.result;
    } catch (e) {
      caught = e;
    }
    expect(isCanceledError(caught)).toBe(true);
    expect(isPausedError(caught)).toBe(false);
    expect(existsSync(partPath())).toBe(false);
    expect(existsSync(metaPath())).toBe(false);
    expect(existsSync(target)).toBe(false);
  });

  it("目标目录不可写（mkdir EACCES）：归为 FS_ERROR，文案含权限引导，不再谎报网络错误（#9b）", async () => {
    const eacces = Object.assign(
      new Error(`EACCES: permission denied, mkdir '${path.dirname(target)}'`),
      { code: "EACCES" },
    );
    mkdirMock.mockRejectedValueOnce(eacces);

    const handle = startDownload({
      url: server.fileUrl,
      targetPath: target,
      expectedSize: file.length,
      sha256: fileSha,
    });
    let caught: unknown;
    try {
      await handle.result;
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DownloadError);
    expect((caught as DownloadError).code).toBe("FS_ERROR");
    expect((caught as Error).message).toContain(eacces.message); // 原始 errno 消息（含路径）保留
    expect((caught as Error).message).toMatch(/非 root/); // 权限引导：面板容器非 root 运行
  });

  it("写入中途磁盘写满（ENOSPC）：归为 FS_ERROR，文案含磁盘空间引导", async () => {
    const enospc = Object.assign(
      new Error("ENOSPC: no space left on device, write"),
      { code: "ENOSPC" },
    );
    // 与 DISK_FULL 预检不同：这里模拟写入过程中真的写满，而非下载前的空间预检
    openMock.mockImplementationOnce(async () => ({
      write: vi.fn().mockRejectedValueOnce(enospc),
      close: vi.fn().mockResolvedValue(undefined),
    }));

    const handle = startDownload({
      url: server.fileUrl,
      targetPath: target,
      expectedSize: file.length,
      sha256: fileSha,
    });
    let caught: unknown;
    try {
      await handle.result;
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DownloadError);
    expect((caught as DownloadError).code).toBe("FS_ERROR");
    expect((caught as Error).message).toMatch(/磁盘空间/);
  });

  it("非文件系统 errno（如 ECONNRESET）不误判为 FS_ERROR，仍归为 NETWORK_ERROR", async () => {
    const econnreset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    mkdirMock.mockRejectedValueOnce(econnreset);

    const handle = startDownload({
      url: server.fileUrl,
      targetPath: target,
      expectedSize: file.length,
      sha256: fileSha,
    });
    let caught: unknown;
    try {
      await handle.result;
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DownloadError);
    expect((caught as DownloadError).code).toBe("NETWORK_ERROR");
  });

  it("checkDiskSpace：不足抛'磁盘空间不足'；充足通过", async () => {
    await expect(checkDiskSpace(tmp, Number.MAX_SAFE_INTEGER)).rejects.toThrow(/磁盘空间不足/);
    await expect(checkDiskSpace(tmp, 1024)).resolves.toBeUndefined();
  });

  it("displayDir 覆盖展示路径：错误文案用宿主机视角而非容器内路径", async () => {
    await expect(checkDiskSpace("/", Number.MAX_SAFE_INTEGER, "/root/workspace/llama/models")).rejects.toThrow(
      /\/root\/workspace\/llama\/models/,
    );
  });

  it("未传 displayDir 时回落到 dir（保持旧行为）", async () => {
    await expect(checkDiskSpace("/", Number.MAX_SAFE_INTEGER)).rejects.toThrow("（/）");
  });
});
