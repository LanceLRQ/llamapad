import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveLocalOid, type CachedFullSha256 } from "./localOid";

const OID = "cbb841a9ee0636b2ec172f5bb8df2ea8dfeb01e90fe7c6126581d662a0b4e43e";
let root: string;

function writeGguf(rel: string, body = "x"): string {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, body);
  return abs;
}

function writeSidecar(rel: string, etag: string): string {
  const abs = path.join(root, rel);
  const dir = path.join(path.dirname(abs), ".cache/huggingface/download");
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${path.basename(abs)}.metadata`);
  writeFileSync(p, `f1bfb127c64f7072bdd2cad55f258b9c8b2910fe\n${etag}\n1786945907.547407\n`);
  return p;
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "localoid-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("resolveLocalOid", () => {
  it("缓存优先：file_meta 有值且 size/mtime 与磁盘一致时不读边车", () => {
    const abs = writeGguf("loose/a.gguf");
    writeSidecar("loose/a.gguf", "b".repeat(64));
    const st = statSync(abs);
    const cached: CachedFullSha256 = { fullSha256: "a".repeat(64), size: st.size, mtime: st.mtimeMs };
    expect(resolveLocalOid(abs, cached)).toBe("a".repeat(64));
  });

  it("缓存 size 与磁盘当前 size 不一致 → 不采信缓存，落到 sidecar（复核修复 K-2）", () => {
    const abs = writeGguf("loose/a.gguf", "xx"); // 磁盘实际 2 字节
    writeSidecar("loose/a.gguf", OID);
    const st = statSync(abs);
    const cached: CachedFullSha256 = { fullSha256: "a".repeat(64), size: st.size + 1, mtime: st.mtimeMs };
    expect(resolveLocalOid(abs, cached)).toBe(OID);
  });

  it("缓存 mtime 与磁盘当前 mtime 不一致 → 不采信缓存，落到 sidecar（复核修复 K-2）", () => {
    const abs = writeGguf("loose/a.gguf");
    const real = statSync(abs); // 磁盘真实 mtime，测试全程不改动它
    writeSidecar("loose/a.gguf", OID); // sidecar 写在 abs 之后，其 mtime 天然不早于 abs
    // 只让「缓存里记的 mtime」与磁盘真实值不符（模拟文件被面板外重新下载覆盖
    // 后旧缓存仍留着旧 mtime），不改动磁盘上 abs 自身的 mtime——否则会连带
    // 触发 sidecar 自己的新鲜度校验（fileMtimeMs > sidecarMtimeMs → null），
    // 掩盖了本测试想验的「缓存新鲜度校验」这一层
    const cached: CachedFullSha256 = { fullSha256: "a".repeat(64), size: real.size, mtime: real.mtimeMs + 1 };
    expect(resolveLocalOid(abs, cached)).toBe(OID);
  });

  it("缓存为空时读边车", () => {
    const abs = writeGguf("loose/a.gguf");
    writeSidecar("loose/a.gguf", OID);
    expect(resolveLocalOid(abs, null)).toBe(OID);
  });

  it("没有边车 → null（不算哈希）", () => {
    const abs = writeGguf("loose/a.gguf");
    expect(resolveLocalOid(abs, null)).toBeNull();
  });

  it("文件在边车之后被改过 → null", () => {
    const abs = writeGguf("loose/a.gguf");
    const side = writeSidecar("loose/a.gguf", OID);
    utimesSync(side, new Date(1_000_000), new Date(1_000_000));
    utimesSync(abs, new Date(2_000_000), new Date(2_000_000));
    expect(resolveLocalOid(abs, null)).toBeNull();
  });

  it("边车格式变形 → null，不抛错", () => {
    const abs = writeGguf("loose/a.gguf");
    const dir = path.join(root, "loose/.cache/huggingface/download");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "a.gguf.metadata"), "{\"etag\": \"whatever\"}");
    expect(resolveLocalOid(abs, null)).toBeNull();
  });
});
