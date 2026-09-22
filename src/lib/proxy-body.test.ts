import { describe, expect, it } from "vitest";
import { readBoundedBodyText } from "./proxy-body";

/** 把若干 Uint8Array chunk 按顺序 enqueue 成一个 ReadableStream，模拟网络分片到达 */
function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

const enc = new TextEncoder();

describe("readBoundedBodyText：带上限的请求体读取", () => {
  it("stream 为 null（无体请求）→ 视为空串，ok true", async () => {
    const result = await readBoundedBodyText(null, 1024);
    expect(result).toEqual({ ok: true, text: "" });
  });

  it("空体 stream（无任何 chunk）→ ok true，空串", async () => {
    const result = await readBoundedBodyText(streamOf(), 1024);
    expect(result).toEqual({ ok: true, text: "" });
  });

  it("单 chunk 正常读取", async () => {
    const result = await readBoundedBodyText(streamOf(enc.encode('{"model":"a"}')), 1024);
    expect(result).toEqual({ ok: true, text: '{"model":"a"}' });
  });

  it("多 chunk 拼接：内容跨 chunk 边界仍正确读出", async () => {
    const body = '{"model":"deepseek-r1","stream":true}';
    const bytes = enc.encode(body);
    const mid = Math.floor(bytes.byteLength / 2);
    const result = await readBoundedBodyText(streamOf(bytes.slice(0, mid), bytes.slice(mid)), 1024);
    expect(result).toEqual({ ok: true, text: body });
  });

  it("总字节数刚好等于上限 → 放行（ok true）", async () => {
    const bytes = enc.encode("abcde");
    const result = await readBoundedBodyText(streamOf(bytes), bytes.byteLength);
    expect(result).toEqual({ ok: true, text: "abcde" });
  });

  it("总字节数超过上限一个字节 → ok false", async () => {
    const bytes = enc.encode("abcdef");
    const result = await readBoundedBodyText(streamOf(bytes), bytes.byteLength - 1);
    expect(result).toEqual({ ok: false });
  });

  it("多 chunk 累计超限：前面 chunk 未超、追加后才超 → 依然拒绝", async () => {
    const chunkA = enc.encode("12345");
    const chunkB = enc.encode("67890");
    const result = await readBoundedBodyText(streamOf(chunkA, chunkB), 8);
    expect(result).toEqual({ ok: false });
  });

  it("多字节 UTF-8 字符恰好被 chunk 边界切开 → 拼接后解码正确，不产生乱码", async () => {
    // "你好" 的 UTF-8 编码共 6 字节（每个汉字 3 字节），在第 2 个字节处切开第一个字符
    const full = enc.encode('{"text":"你好"}');
    const cut = full.indexOf(enc.encode("你")[0]) + 1; // 切在"你"的第 1 个字节之后
    const result = await readBoundedBodyText(streamOf(full.slice(0, cut), full.slice(cut)), 1024);
    expect(result).toEqual({ ok: true, text: '{"text":"你好"}' });
  });
});
