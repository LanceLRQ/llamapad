/**
 * GGUF 字节流测试构造器：供 gguf.test.ts（内存 Buffer + bufferReader）与
 * server/ggufMeta.test.ts（落盘真实文件 + fs 句柄读取）共用，避免同一构造逻辑
 * 在两处漂移。只支持仓库测试用到的值类型（U32/U64/STRING/BOOL/ARRAY）。
 */
export function buildGguf(kv: Array<[string, { t: number; v: unknown }]>, opts?: { version?: number }): Buffer {
  const parts: Buffer[] = [];
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const u64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const str = (s: string) => { const d = Buffer.from(s, "utf8"); return Buffer.concat([u64(d.length), d]); };
  parts.push(Buffer.from("GGUF", "ascii"), u32(opts?.version ?? 3), u64(0), u64(kv.length));
  for (const [k, { t, v }] of kv) {
    parts.push(str(k), u32(t));
    if (t === 8) parts.push(str(v as string));
    else if (t === 4) parts.push(u32(v as number));
    else if (t === 10) parts.push(u64(v as number));
    else if (t === 7) parts.push(Buffer.from([v ? 1 : 0]));
    else if (t === 9) {
      const [et, arr] = v as [number, unknown[]];
      parts.push(u32(et), u64(arr.length));
      for (const e of arr) parts.push(et === 8 ? str(e as string) : u32(e as number));
    }
  }
  return Buffer.concat(parts);
}
