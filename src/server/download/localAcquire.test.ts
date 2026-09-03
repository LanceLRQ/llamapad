import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { runLocalAcquire } from "./localAcquire";
import { isCanceledError } from "./downloader";

let root: string;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function world(content = "hello-weights"): { src: string; dst: string; sha: string; size: number } {
  root = mkdtempSync(path.join(tmpdir(), "acquire-"));
  const src = path.join(root, "src.gguf");
  writeFileSync(src, content);
  return {
    src,
    dst: path.join(root, "dst.gguf"),
    sha: createHash("sha256").update(content).digest("hex"),
    size: Buffer.byteLength(content),
  };
}

describe("runLocalAcquire 校验阶段", () => {
  it("sha256 相符时进入执行阶段——执行阶段本任务未实现，故 reject 而非返回哈希", async () => {
    // 断言的是「没有在校验阶段就被拒」：错误消息若是"未实现"而不是"内容不符"，
    // 就证明 sha256 计算与比对已经通过，只是执行阶段（任务 7/8）还没接上
    const w = world();
    await expect(
      runLocalAcquire({
        sourcePath: w.src,
        targetPath: w.dst,
        action: "link",
        sameFs: true,
        expectedSize: w.size,
        sha256: w.sha,
      }).result,
    ).rejects.toThrow(/未实现/);
  });

  it("sha256 不符时 reject，且不产生任何目标文件", async () => {
    const w = world();
    await expect(
      runLocalAcquire({
        sourcePath: w.src,
        targetPath: w.dst,
        action: "link",
        sameFs: true,
        expectedSize: w.size,
        sha256: "b".repeat(64),
      }).result,
    ).rejects.toThrow(/内容不符/);
    expect(() => readFileSync(w.dst)).toThrow();
  });

  it("源文件大小与声明不符时 reject——先于哈希检查，省掉整趟读盘", async () => {
    const w = world();
    await expect(
      runLocalAcquire({
        sourcePath: w.src,
        targetPath: w.dst,
        action: "link",
        sameFs: true,
        expectedSize: w.size + 1,
        sha256: w.sha,
      }).result,
    ).rejects.toThrow(/大小不符/);
  });

  it("cancel 后 reject 为取消错误", async () => {
    const w = world("x".repeat(4_000_000));
    const h = runLocalAcquire({
      sourcePath: w.src,
      targetPath: w.dst,
      action: "copy",
      sameFs: false,
      expectedSize: w.size,
      sha256: w.sha,
    });
    await h.cancel();
    await expect(h.result).rejects.toSatisfy(isCanceledError);
  });

  it("进度回调的 total 在校验阶段全程等于 size（link 场景）", async () => {
    // 执行阶段尚未实现（本任务未实现的部分），所以只能验证校验阶段——那是本任务
    // 唯一实现的部分——的进度上报；copy 的 total×2 留给任务 7/8 补的执行阶段测试
    const w = world();
    const totals: (number | null)[] = [];
    await expect(
      runLocalAcquire(
        { sourcePath: w.src, targetPath: w.dst, action: "link", sameFs: true, expectedSize: w.size, sha256: w.sha },
        (p) => totals.push(p.total),
      ).result,
    ).rejects.toThrow(/未实现/);
    expect(totals.length).toBeGreaterThan(0);
    expect(totals.every((t) => t === w.size)).toBe(true);
  });
});
