/**
 * 带上限的请求体读取（纯函数，供推理中转 route 薄壳调用）
 *
 * 目的：判断"这次 POST 该发给哪个模型"必须先看请求体里的 model 字段，但请求体
 * 大小是客户端自报的 content-length，不可信（可能缺失、可能撒谎）——只信
 * content-length 会让"体积正好卡在阈值上下"或"没带这个头"的请求走上完全不同的
 * 处理路径（旧实现：缺头就当"超限"，静默发默认模型，正是本次要修的缺陷）。
 * 改为不看头、只看实际读到的字节数，读够上限就中止，语义唯一：
 * 读得动就一定读完，读不动（真的超限）就一定拒绝，没有"看头猜大小"的中间态。
 */

/** readBoundedBodyText 的返回形态：ok 为 true 时 text 是完整拼接、解码后的正文 */
export type BoundedReadResult = { ok: true; text: string } | { ok: false };

/**
 * 按字节上限流式读取 body 并解码为字符串。
 *
 * - stream 为 null（GET/HEAD 等无体请求，或某些环境下的空 POST 体）→ 视为空串，直接放行
 * - 逐 chunk 累计已读字节数，一旦超过 maxBytes 立即 cancel 底层流并返回 {ok:false}，
 *   不会把超限的内容继续读进内存——上限是"读取上限"而非"事后校验上限"
 * - 多字节 UTF-8 字符可能被 chunk 边界切开（如 fetch/undici 按网络包大小分片），
 *   因此不逐 chunk 解码，而是先把所有 chunk 的原始字节拼成一个连续 Uint8Array，
 *   读完再一次性 TextDecoder().decode()，跨 chunk 的多字节序列不会被切裂译错
 */
export async function readBoundedBodyText(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<BoundedReadResult> {
  if (stream === null) return { ok: true, text: "" };

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return { ok: false };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(buffer) };
}
