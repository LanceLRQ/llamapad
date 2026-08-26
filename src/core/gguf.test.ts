import { describe, expect, it } from "vitest";
import { bufferReader, parseGguf, GGUF_INTEREST } from "./gguf";
import { buildGguf } from "./gguf.testkit";

describe("parseGguf", () => {
  it("解析 architecture / block_count / context_length / file_type", async () => {
    const buf = buildGguf([
      ["general.architecture", { t: 8, v: "llama" }],
      ["general.file_type", { t: 4, v: 15 }],
      ["llama.block_count", { t: 4, v: 32 }],
      ["llama.context_length", { t: 4, v: 8192 }],
    ]);
    const meta = await parseGguf(bufferReader(buf));
    expect(meta).toEqual({
      version: 3, architecture: "llama", blockCount: 32, contextLength: 8192, fileType: 15, truncated: false,
    });
  });

  it("跳过巨大的 tokenizer 数组与 blob 而不解析其内容", async () => {
    // 两种典型巨型值：变长 STRING 数组（每元素必读 8 字节长度头才能定位下一个）
    // 与单个大 blob（读 8 字节长度头后整段跳过）。前者的长度头开销与短 token 的
    // 内容长度同量级，单独用它衡量跳值效果分辨率不够，故与 blob 组合断言。
    const tokens = Array.from({ length: 5000 }, (_, i) => `tok_${i}`);
    const blob = "x".repeat(200_000);
    const buf = buildGguf([
      ["tokenizer.ggml.tokens", { t: 9, v: [8, tokens] }],
      ["tokenizer.chat_template", { t: 8, v: blob }],
      [GGUF_INTEREST.architecture, { t: 8, v: "qwen2" }],
      [`qwen2${GGUF_INTEREST.blockCountSuffix}`, { t: 10, v: 64 }],
    ]);
    const reader = bufferReader(buf);
    const meta = await parseGguf(reader);
    expect(meta.architecture).toBe("qwen2");
    expect(meta.blockCount).toBe(64);
    // 跳值生效：20 万字节的 blob 内容一字节未读，词表只读了各元素的长度头
    expect(reader.bytesRead()).toBeLessThan(buf.length / 2);
    expect(reader.bytesRead()).toBeLessThan(45_000);
  });

  it("整数宽度不固定：block_count 为 U64 / context_length 为 U32 都能读", async () => {
    const buf = buildGguf([
      ["general.architecture", { t: 8, v: "llama" }],
      ["llama.block_count", { t: 10, v: 80 }],
      ["llama.context_length", { t: 4, v: 131072 }],
    ]);
    const meta = await parseGguf(bufferReader(buf));
    expect(meta.blockCount).toBe(80);
    expect(meta.contextLength).toBe(131072);
  });

  it("magic 不匹配抛 GgufError", async () => {
    const bad = Buffer.concat([Buffer.from("XXXX", "ascii"), Buffer.alloc(20)]);
    await expect(parseGguf(bufferReader(bad))).rejects.toThrow(/不是 GGUF/);
  });

  it("超出扫描预算时标记 truncated 而非抛错", async () => {
    const many = Array.from({ length: 400 }, (_, i) =>
      [`pad.key_${i}`, { t: 8, v: "x".repeat(400) }] as [string, { t: number; v: unknown }]);
    const buf = buildGguf([...many, ["general.architecture", { t: 8, v: "llama" }]]);
    const meta = await parseGguf(bufferReader(buf), { maxScanBytes: 4096 });
    expect(meta.truncated).toBe(true);
    expect(meta.architecture).toBeNull();
  });

  it("缺失的键返回 null 而非报错", async () => {
    const buf = buildGguf([["general.architecture", { t: 8, v: "gemma" }]]);
    const meta = await parseGguf(bufferReader(buf));
    expect(meta).toMatchObject({ architecture: "gemma", blockCount: null, contextLength: null, fileType: null });
  });
});
