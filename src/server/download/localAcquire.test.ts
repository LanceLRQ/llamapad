import { execFileSync } from "node:child_process";
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

/**
 * 探测当前环境是否支持 chattr +i（不可变位）：测试大概率以 root 跑，天然绕过普通的
 * 文件/目录权限位（chmod 挡不住 root），immutable 属性是少数能在这种环境里真实拦住
 * unlink 的手段——且它只挡删除/改名，不挡读取，正好用来在不 mock fs 的前提下造出
 * 「复制成功、删源失败」这个真实场景。探测失败（命令不存在、文件系统不支持该 ioctl，
 * 如 tmpfs/某些 overlay 配置）就跳过对应用例，而不是伪造一个不代表真实失败路径的假象。
 */
function canMakeImmutable(): boolean {
  const dir = mkdtempSync(path.join(tmpdir(), "immutable-probe-"));
  const probe = path.join(dir, "f");
  try {
    writeFileSync(probe, "x");
    execFileSync("chattr", ["+i", probe], { stdio: "ignore" });
    let blocked = false;
    try {
      rmSync(probe);
    } catch {
      blocked = true;
    }
    execFileSync("chattr", ["-i", probe], { stdio: "ignore" });
    return blocked;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const chattrSupported = canMakeImmutable();

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

  it("link 目标已存在：覆盖而不是抛裸 EEXIST——与 move/copy 的覆盖语义对齐", async () => {
    const w = world();
    writeFileSync(w.dst, "stale-leftover"); // 模拟上次残缺下载留下的旧文件
    await runLocalAcquire({
      sourcePath: w.src, targetPath: w.dst, action: "link",
      sameFs: true, expectedSize: w.size, sha256: w.sha,
    }).result;
    expect(statSync(w.src).ino).toBe(statSync(w.dst).ino);
  });
});

describe("copyStream", () => {
  it("copy：源保留、目标出现、内容一致", async () => {
    const w = world();
    await runLocalAcquire({
      sourcePath: w.src, targetPath: w.dst, action: "copy",
      sameFs: false, expectedSize: w.size, sha256: w.sha,
    }).result;
    expect(existsSync(w.src)).toBe(true);
    expect(readFileSync(w.dst, "utf8")).toBe("hello-weights");
  });

  it("跨盘 move：复制完成后源被删除", async () => {
    const w = world();
    await runLocalAcquire({
      sourcePath: w.src, targetPath: w.dst, action: "move",
      sameFs: false, expectedSize: w.size, sha256: w.sha,
    }).result;
    expect(existsSync(w.src)).toBe(false);
    expect(readFileSync(w.dst, "utf8")).toBe("hello-weights");
  });

  it("复制过程中取消：目标位置无半成品，.part 也被删除", async () => {
    const w = world("y".repeat(8_000_000));
    const h = runLocalAcquire({
      sourcePath: w.src, targetPath: w.dst, action: "copy",
      sameFs: false, expectedSize: w.size, sha256: w.sha,
    });
    setTimeout(() => void h.cancel(), 5);
    await expect(h.result).rejects.toSatisfy(isCanceledError);
    expect(existsSync(w.dst)).toBe(false);
    expect(existsSync(w.dst + ".part")).toBe(false);
  });

  it("进度跨越两阶段单调递增，最终等于 size × 2", async () => {
    const w = world("z".repeat(200_000));
    const seen: number[] = [];
    await runLocalAcquire(
      { sourcePath: w.src, targetPath: w.dst, action: "copy", sameFs: false, expectedSize: w.size, sha256: w.sha },
      (p) => seen.push(p.downloaded),
    ).result;
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(seen.at(-1)).toBe(w.size * 2);
  });

  it("copy 目标已存在：覆盖而不是留下冲突", async () => {
    const w = world();
    writeFileSync(w.dst, "stale-leftover-content");
    await runLocalAcquire({
      sourcePath: w.src, targetPath: w.dst, action: "copy",
      sameFs: false, expectedSize: w.size, sha256: w.sha,
    }).result;
    expect(readFileSync(w.dst, "utf8")).toBe("hello-weights");
  });

  // 只在支持 chattr +i 的环境跑（见 canMakeImmutable）；不支持时跳过而非伪造 mock，
  // 真实验证方式与手动交叉验证记录见 task-8-report.md
  it.skipIf(!chattrSupported)(
    "跨盘 move：复制成功但删源失败——目标文件保留，报错标明源仍在原处",
    async () => {
      const w = world();
      execFileSync("chattr", ["+i", w.src]);
      try {
        await expect(
          runLocalAcquire({
            sourcePath: w.src, targetPath: w.dst, action: "move",
            sameFs: false, expectedSize: w.size, sha256: w.sha,
          }).result,
        ).rejects.toThrow(/SOURCE_DELETE_FAILED/);
        expect(readFileSync(w.dst, "utf8")).toBe("hello-weights"); // 复制已经落位，不是"什么都没发生"
        expect(existsSync(w.src)).toBe(true); // 删源失败，源必须还在
      } finally {
        // 解除不可变位，afterEach 的 rmSync 才能清理掉整个临时目录
        execFileSync("chattr", ["-i", w.src], { stdio: "ignore" });
      }
    },
  );
});
