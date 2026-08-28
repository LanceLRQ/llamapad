import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  computeFullHash,
  computeSampleHash,
  le64,
  SAMPLE_CHUNK_BYTES,
  SAMPLE_THRESHOLD_BYTES,
  sampleHashOf,
} from "./fingerprint";

/** 手工实现同一定义，用来核对 IO 层结果（与被测代码物理隔离，不共享实现） */
function manualSampleHash(size: number, parts: Buffer[]): string {
  const hash = createHash("sha256");
  const sizeBuf = Buffer.alloc(8);
  sizeBuf.writeBigUInt64LE(BigInt(size));
  hash.update(sizeBuf);
  for (const part of parts) hash.update(part);
  return hash.digest("hex");
}

describe("le64", () => {
  it("按小端序编码为 8 字节", () => {
    expect(le64(1)).toEqual(Buffer.from([1, 0, 0, 0, 0, 0, 0, 0]));
    expect(le64(256)).toEqual(Buffer.from([0, 1, 0, 0, 0, 0, 0, 0]));
    expect(le64(0)).toEqual(Buffer.alloc(8));
  });
});

describe("sampleHashOf（纯逻辑，不涉及磁盘）", () => {
  it(">= 8 MiB 分支：头尾两块拼接参与摘要", () => {
    const size = SAMPLE_THRESHOLD_BYTES + 1000;
    const head = Buffer.alloc(SAMPLE_CHUNK_BYTES, "h");
    const tail = Buffer.alloc(SAMPLE_CHUNK_BYTES, "t");
    const actual = sampleHashOf(size, [head, tail]);
    expect(actual).toBe(manualSampleHash(size, [head, tail]));
  });

  it("< 8 MiB 分支：整个文件内容参与摘要", () => {
    const size = 100;
    const whole = Buffer.alloc(size, "x");
    const actual = sampleHashOf(size, [whole]);
    expect(actual).toBe(manualSampleHash(size, [whole]));
  });

  it("同一输入跨调用值稳定", () => {
    const size = 12345;
    const buf = Buffer.from("stable-content");
    const first = sampleHashOf(size, [buf]);
    const second = sampleHashOf(size, [buf]);
    expect(first).toBe(second);
  });

  it("size 参与摘要：相同字节内容但不同 size 得到不同哈希", () => {
    const buf = Buffer.from("same-bytes");
    const a = sampleHashOf(100, [buf]);
    const b = sampleHashOf(200, [buf]);
    expect(a).not.toBe(b);
  });

  it("字节内容不同则哈希不同（其余不变）", () => {
    const a = sampleHashOf(10, [Buffer.from("aaaaaaaaaa")]);
    const b = sampleHashOf(10, [Buffer.from("bbbbbbbbbb")]);
    expect(a).not.toBe(b);
  });
});

describe("computeSampleHash / computeFullHash（IO 层）", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "llamapad-fingerprint-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("< 8 MiB 文件：采样哈希等于手工计算的「整文件」摘要", async () => {
    const size = 100;
    const content = Buffer.alloc(size, "y");
    const file = path.join(dir, "small.gguf");
    writeFileSync(file, content);

    const actual = await computeSampleHash(file);
    expect(actual).toBe(manualSampleHash(size, [content]));
  });

  it("空文件（0 字节）不抛错，走 < 8 MiB 分支", async () => {
    const file = path.join(dir, "empty.gguf");
    writeFileSync(file, Buffer.alloc(0));

    const actual = await computeSampleHash(file);
    expect(actual).toBe(manualSampleHash(0, [Buffer.alloc(0)]));
  });

  it(">= 8 MiB 文件：采样哈希只取头尾各 4 MiB，与手工计算一致", async () => {
    const size = SAMPLE_THRESHOLD_BYTES + 1024; // 略大于阈值，中段字节不应参与摘要
    const content = Buffer.alloc(size);
    // 头尾放明显不同的字节，中段放第三种字节，验证只有头尾被采样
    content.fill(0xaa, 0, SAMPLE_CHUNK_BYTES);
    content.fill(0xcc, SAMPLE_CHUNK_BYTES, size - SAMPLE_CHUNK_BYTES);
    content.fill(0xbb, size - SAMPLE_CHUNK_BYTES, size);
    const file = path.join(dir, "large.gguf");
    writeFileSync(file, content);

    const actual = await computeSampleHash(file);
    const head = content.subarray(0, SAMPLE_CHUNK_BYTES);
    const tail = content.subarray(size - SAMPLE_CHUNK_BYTES, size);
    expect(actual).toBe(manualSampleHash(size, [head, tail]));

    // 中段被篡改不影响采样哈希（因为根本没被读取参与摘要）
    const tampered = Buffer.from(content);
    tampered.fill(0xff, SAMPLE_CHUNK_BYTES, size - SAMPLE_CHUNK_BYTES);
    const tamperedFile = path.join(dir, "large-tampered.gguf");
    writeFileSync(tamperedFile, tampered);
    const tamperedHash = await computeSampleHash(tamperedFile);
    expect(tamperedHash).toBe(actual);
  });

  it("边界值：size 恰好等于 8 MiB 阈值时走 >= 分支（头尾各 4 MiB，无中段）", async () => {
    const size = SAMPLE_THRESHOLD_BYTES;
    const content = Buffer.alloc(size);
    content.fill(0xaa, 0, SAMPLE_CHUNK_BYTES);
    content.fill(0xbb, SAMPLE_CHUNK_BYTES, size);
    const file = path.join(dir, "boundary.gguf");
    writeFileSync(file, content);

    const actual = await computeSampleHash(file);
    const head = content.subarray(0, SAMPLE_CHUNK_BYTES);
    const tail = content.subarray(SAMPLE_CHUNK_BYTES, size);
    expect(actual).toBe(manualSampleHash(size, [head, tail]));
  });

  it("同一内容跨调用值稳定", async () => {
    const file = path.join(dir, "stable.gguf");
    writeFileSync(file, Buffer.alloc(1000, "s"));
    const first = await computeSampleHash(file);
    const second = await computeSampleHash(file);
    expect(first).toBe(second);
  });

  it("computeFullHash 等于整文件内容的 sha256", async () => {
    const content = Buffer.alloc(1000, "z");
    const file = path.join(dir, "full.gguf");
    writeFileSync(file, content);

    const actual = await computeFullHash(file);
    expect(actual).toBe(createHash("sha256").update(content).digest("hex"));
  });
});
