/**
 * 文件指纹：采样哈希 + 完整哈希（M-文件元信息，设计 §3.3）
 *
 * 纯逻辑（sampleHashOf）与 IO（computeSampleHash / computeFullHash）分离：
 * 前者只吃内存里的字节，可脱离磁盘单测；后者负责决定读文件的哪些字节。
 *
 * 采样哈希定义（跨版本必须逐字一致，否则历史记录全部作废）：
 *   size >= 8 MiB：sha256( LE64(size) || 文件前 4 MiB || 文件后 4 MiB )
 *   size <  8 MiB：sha256( LE64(size) || 整个文件 )
 * 固定 8 MiB I/O 上限，与文件实际大小无关（88GB 文件与 100MB 文件读同样多字节）。
 *
 * 完整哈希 = 整个文件内容的 sha256，用流式读取，不整文件载入内存。
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";

/** 采样哈希单侧（头/尾）读取字节数 */
export const SAMPLE_CHUNK_BYTES = 4 * 1024 * 1024;

/** 采样哈希分支阈值：达到此大小才切头尾采样，否则整文件参与摘要 */
export const SAMPLE_THRESHOLD_BYTES = SAMPLE_CHUNK_BYTES * 2;

/** 文件字节数的 64 位小端表示（8 字节），采样哈希摘要的固定前缀 */
export function le64(size: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(size));
  return buf;
}

/**
 * 采样哈希纯逻辑：摘要 = sha256( LE64(size) || parts 依次拼接 )。
 * parts 由调用方（IO 层）按 size 是否 >= 8 MiB 决定传入头尾两块还是整个文件，
 * 本函数不关心来源，只管拼接与摘要——这一层可以完全脱离磁盘测试。
 */
export function sampleHashOf(size: number, parts: Buffer[]): string {
  const hash = createHash("sha256");
  hash.update(le64(size));
  for (const part of parts) hash.update(part);
  return hash.digest("hex");
}

/**
 * 读文件计算采样哈希（IO 层）。size >= 8 MiB 时只读头 4 MiB + 尾 4 MiB，
 * 不管文件本身多大都只发生这固定 8 MiB 的顺序读；size < 8 MiB 时整文件参与。
 */
export async function computeSampleHash(absPath: string): Promise<string> {
  const handle = await open(absPath, "r");
  try {
    const { size } = await handle.stat();
    if (size < SAMPLE_THRESHOLD_BYTES) {
      const whole = Buffer.alloc(size);
      if (size > 0) await handle.read(whole, 0, size, 0);
      return sampleHashOf(size, [whole]);
    }
    const head = Buffer.alloc(SAMPLE_CHUNK_BYTES);
    await handle.read(head, 0, SAMPLE_CHUNK_BYTES, 0);
    const tail = Buffer.alloc(SAMPLE_CHUNK_BYTES);
    await handle.read(tail, 0, SAMPLE_CHUNK_BYTES, size - SAMPLE_CHUNK_BYTES);
    return sampleHashOf(size, [head, tail]);
  } finally {
    await handle.close();
  }
}

/** 完整哈希（IO 层）：流式读取整文件，供大文件也不整体载入内存 */
export function computeFullHash(absPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(absPath);
    stream.on("data", (chunk: string | Buffer) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}
