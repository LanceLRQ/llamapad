import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveLocalOid } from "./localOid";

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
  it("缓存优先：file_meta 有值时不读边车", () => {
    const abs = writeGguf("loose/a.gguf");
    writeSidecar("loose/a.gguf", "b".repeat(64));
    expect(resolveLocalOid(abs, "a".repeat(64))).toBe("a".repeat(64));
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
