import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  it("sha256 相符时进入执行阶段——copy 尚未实现，故 reject 而非返回哈希", async () => {
    // 断言的是「没有在校验阶段就被拒」：错误消息若是"未实现"而不是"内容不符"，
    // 就证明 sha256 计算与比对已经通过，只是 copy 执行阶段（任务 8）还没接上。
    // 用 copy 而非 link/同盘 move 是因为后两者已在本任务（任务 7）落地，不再适合
    // 验证"校验通过、执行未接上"这件事
    const w = world();
    await expect(
      runLocalAcquire({
        sourcePath: w.src,
        targetPath: w.dst,
        action: "copy",
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
    // 用 sameFs: false 让 link 走 performAction 里的 CROSS_DEVICE 直接拒绝——只是借它
    // 制造一个校验通过后必然失败的收尾，不干扰断言；真正要验证的是校验阶段（本用例
    // 唯一覆盖的阶段）上报的 total 全程等于 size 而非翻倍，翻倍是 copy 类操作才有的
    // 记账（见 totalWorkOf），link 不需要
    const w = world();
    const totals: (number | null)[] = [];
    await expect(
      runLocalAcquire(
        { sourcePath: w.src, targetPath: w.dst, action: "link", sameFs: false, expectedSize: w.size, sha256: w.sha },
        (p) => totals.push(p.total),
      ).result,
    ).rejects.toThrow(/CROSS_DEVICE/);
    expect(totals.length).toBeGreaterThan(0);
    expect(totals.every((t) => t === w.size)).toBe(true);
  });
});

describe("performAction: move / link", () => {
  it("move 同盘：源消失、目标出现", async () => {
    const w = world();
    await runLocalAcquire({
      sourcePath: w.src, targetPath: w.dst, action: "move",
      sameFs: true, expectedSize: w.size, sha256: w.sha,
    }).result;
    expect(existsSync(w.src)).toBe(false);
    expect(readFileSync(w.dst, "utf8")).toBe("hello-weights");
  });

  it("link 同盘：源与目标都在，且是同一个 inode", async () => {
    const w = world();
    await runLocalAcquire({
      sourcePath: w.src, targetPath: w.dst, action: "link",
      sameFs: true, expectedSize: w.size, sha256: w.sha,
    }).result;
    expect(statSync(w.src).ino).toBe(statSync(w.dst).ino);
  });

  it("link 跨文件系统：直接拒绝，不做无谓尝试", async () => {
    const w = world();
    await expect(
      runLocalAcquire({
        sourcePath: w.src, targetPath: w.dst, action: "link",
        sameFs: false, expectedSize: w.size, sha256: w.sha,
      }).result,
    ).rejects.toThrow(/CROSS_DEVICE/);
  });

  it("目标目录不存在时自动创建——档案目录一定在，但子目录可能没有", async () => {
    const w = world();
    const nested = path.join(root, "a/b/c/dst.gguf");
    await runLocalAcquire({
      sourcePath: w.src, targetPath: nested, action: "move",
      sameFs: true, expectedSize: w.size, sha256: w.sha,
    }).result;
    expect(existsSync(nested)).toBe(true);
  });
});
