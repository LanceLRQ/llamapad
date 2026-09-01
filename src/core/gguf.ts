/**
 * GGUF 文件头解析纯逻辑（UX P1 U16 前半，注入式 ByteReader，无 IO）
 *
 * GGUF 二进制布局（规格 v3，小端）：
 *   magic(u32) "GGUF" → version(u32) → tensor_count(u64) → metadata_kv_count(u64) → KV 数组
 * 每个 KV：key(u64 长度 + UTF-8 字节) → value_type(u32) → 值。
 * 值类型枚举：0=U8 1=I8 2=U16 3=I16 4=U32 5=I32 6=F32 7=BOOL 8=STRING 9=ARRAY 10=U64 11=I64 12=F64。
 * ARRAY 值 = elem_type(u32) + len(u64) + 元素序列。
 *
 * 词表（tokenizer.ggml.tokens）等数组可达几 MB，绝不能整段读进内存：只对「关心」的键
 * 读取完整值，其余键的值只读出定位所需的类型/长度信息，值本身只推进游标不发起读取。
 * KV 顺序不保证 general.architecture 排在前面，因此先扫完全部 KV 收集到 map，
 * 扫完后再用 architecture 解释 `{arch}.block_count` / `{arch}.context_length`。
 *
 * tokenizer.chat_template 也是「关心」的键（近 10KB 量级的 jinja 源码，供
 * lib/reasoning-effort.ts 判定「思考强度」是否受支持），量级远小于 DEFAULT_MAX_SCAN_BYTES
 * （16MB）的扫描预算，整体读入不构成风险。
 */

/** 注入式字节源：offset 定位随机读取；read 越界返回实际可得的短 Buffer（供上层判断截断） */
export interface ByteReader {
  read(offset: number, length: number): Promise<Buffer>;
  bytesRead(): number;
}

/** 供测试及小文件场景使用的内存实现；真实文件读取见 server/ggufMeta.ts 的 fileReader */
export function bufferReader(buf: Buffer): ByteReader {
  let totalRead = 0;
  return {
    async read(offset, length) {
      if (offset >= buf.length) return Buffer.alloc(0);
      const slice = buf.subarray(offset, Math.min(offset + length, buf.length));
      totalRead += slice.length;
      return slice;
    },
    bytesRead() {
      return totalRead;
    },
  };
}

export interface GgufMeta {
  version: number;
  architecture: string | null;
  blockCount: number | null;
  contextLength: number | null;
  fileType: number | null;
  /** chat template（jinja 源码，STRING 类型，近 10KB 量级）；GGUF 未内嵌模板时为 null */
  chatTemplate: string | null;
  truncated: boolean;
}

/** GgufMeta 去掉 chatTemplate 的视图：page.tsx 传给 client 组件时用它，chat template
 *  近 10KB 量级、只在服务端判定「思考强度」支持态时用得到，原样下发会整个塞进 RSC payload */
export type GgufMetaView = Omit<GgufMeta, "chatTemplate">;

/** 仅 magic 不匹配时抛出；其余异常情况（截断/越预算/未知类型）一律走 truncated 语义 */
export class GgufError extends Error {}

/** 关心的键：固定键 + 依赖 architecture 前缀的后缀键；扫描阶段按此收集，扫完再解释 */
export const GGUF_INTEREST = {
  architecture: "general.architecture",
  fileType: "general.file_type",
  blockCountSuffix: ".block_count",
  contextLengthSuffix: ".context_length",
  /** 「思考强度」reasoning_effort 判定的唯一数据来源，见 lib/reasoning-effort.ts */
  chatTemplate: "tokenizer.chat_template",
} as const;

const MAGIC = 0x46554747; // "GGUF" 四字节按小端读作 u32 的值
const DEFAULT_MAX_SCAN_BYTES = 16 * 1024 * 1024;

const T_U8 = 0, T_I8 = 1, T_U16 = 2, T_I16 = 3, T_U32 = 4, T_I32 = 5, T_F32 = 6;
const T_BOOL = 7, T_STRING = 8, T_ARRAY = 9, T_U64 = 10, T_I64 = 11, T_F64 = 12;

/** 固定宽度类型的字节数；STRING/ARRAY 等非固定宽度类型返回 null */
function fixedWidth(type: number): number | null {
  switch (type) {
    case T_U8: case T_I8: case T_BOOL: return 1;
    case T_U16: case T_I16: return 2;
    case T_U32: case T_I32: case T_F32: return 4;
    case T_U64: case T_I64: case T_F64: return 8;
    default: return null;
  }
}

/** 整数读取统一入口：接受 U8/I8/U16/I16/U32/I32/U64/I64 八种宽度（风险簿#2，实际写入宽度不固定） */
function readNumeric(type: number, bytes: Buffer): number | null {
  switch (type) {
    case T_U8: return bytes.readUInt8(0);
    case T_I8: return bytes.readInt8(0);
    case T_U16: return bytes.readUInt16LE(0);
    case T_I16: return bytes.readInt16LE(0);
    case T_U32: return bytes.readUInt32LE(0);
    case T_I32: return bytes.readInt32LE(0);
    case T_U64: {
      const n = bytes.readBigUInt64LE(0);
      return n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : null; // 超安全整数范围的异常文件防御性截断
    }
    case T_I64: {
      const n = bytes.readBigInt64LE(0);
      return n >= BigInt(Number.MIN_SAFE_INTEGER) && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : null;
    }
    default: return null;
  }
}

/** 顺序游标：pos 是文件内的逻辑偏移；skip 只推进 pos 不发起读取，是跳值不落缓冲的核心 */
class Cursor {
  pos = 0;
  constructor(
    private reader: ByteReader,
    private maxScanBytes: number,
  ) {}

  get overBudget(): boolean {
    return this.pos > this.maxScanBytes;
  }

  /** 读取 n 字节并推进 pos；实际可得字节数不足 n 时返回短 buffer，调用方据此判定截断 */
  async take(n: number): Promise<Buffer> {
    const buf = await this.reader.read(this.pos, n);
    this.pos += n;
    return buf;
  }

  /** 跳过 n 字节：只推进 pos，不调用 reader.read——不关心的值绝不落缓冲 */
  skip(n: number): void {
    this.pos += n;
  }
}

function isInterestKey(key: string): boolean {
  return (
    key === GGUF_INTEREST.architecture ||
    key === GGUF_INTEREST.fileType ||
    key === GGUF_INTEREST.chatTemplate ||
    key.endsWith(GGUF_INTEREST.blockCountSuffix) ||
    key.endsWith(GGUF_INTEREST.contextLengthSuffix)
  );
}

/**
 * 消费一个 KV 的值：keep=true 时完整读取并回调 onValue，否则只读定位所需信息后跳过内容。
 * 返回 false 表示遇到字节不足或未知类型等不可续解析的情况，调用方应转入 truncated。
 */
async function consumeValue(
  type: number,
  cursor: Cursor,
  keep: boolean,
  onValue: (v: number | string) => void,
): Promise<boolean> {
  const width = fixedWidth(type);
  if (width !== null) {
    if (!keep) {
      cursor.skip(width);
      return true;
    }
    const buf = await cursor.take(width);
    if (buf.length < width) return false;
    const n = readNumeric(type, buf);
    if (n !== null) onValue(n);
    return true;
  }

  if (type === T_STRING) {
    const lenBuf = await cursor.take(8);
    if (lenBuf.length < 8) return false;
    const len = Number(lenBuf.readBigUInt64LE(0));
    if (!keep) {
      cursor.skip(len); // 跳值生效的关键：不关心的字符串内容绝不读取
      return true;
    }
    const content = await cursor.take(len);
    if (content.length < len) return false;
    onValue(content.toString("utf8"));
    return true;
  }

  if (type === T_ARRAY) {
    const elemTypeBuf = await cursor.take(4);
    if (elemTypeBuf.length < 4) return false;
    const elemType = elemTypeBuf.readUInt32LE(0);
    const countBuf = await cursor.take(8);
    if (countBuf.length < 8) return false;
    const count = Number(countBuf.readBigUInt64LE(0));
    // GGUF_INTEREST 里没有数组类型的键，数组值本身从不 keep，只需正确跳过
    return skipArrayElements(elemType, count, cursor);
  }

  return false; // 规格外的未知类型：无法确定如何跳过，交给上层判 truncated
}

/**
 * 跳过数组的全部元素：固定宽度元素一次性按 elemWidth*count 前进（词表这类巨大数组
 * 常见的定长场景，零逐元素开销）；STRING 元素变长，逐个读 8 字节长度头再跳内容
 * （风险簿#1 的核心场景——只读类型+长度，绝不解析内容）。
 */
async function skipArrayElements(elemType: number, count: number, cursor: Cursor): Promise<boolean> {
  const width = fixedWidth(elemType);
  if (width !== null) {
    cursor.skip(width * count);
    return true;
  }
  if (elemType === T_STRING) {
    for (let i = 0; i < count; i++) {
      if (cursor.overBudget) return false;
      const lenBuf = await cursor.take(8);
      if (lenBuf.length < 8) return false;
      cursor.skip(Number(lenBuf.readBigUInt64LE(0)));
    }
    return true;
  }
  return false; // 嵌套 ARRAY 等规格未定义的元素类型
}

export async function parseGguf(reader: ByteReader, opts?: { maxScanBytes?: number }): Promise<GgufMeta> {
  const maxScanBytes = opts?.maxScanBytes ?? DEFAULT_MAX_SCAN_BYTES;
  const cursor = new Cursor(reader, maxScanBytes);

  const magicBuf = await cursor.take(4);
  if (magicBuf.length < 4 || magicBuf.readUInt32LE(0) !== MAGIC) {
    throw new GgufError("不是 GGUF 文件：magic 不匹配");
  }

  const versionBuf = await cursor.take(4);
  const version = versionBuf.length >= 4 ? versionBuf.readUInt32LE(0) : 0;

  await cursor.take(8); // tensor_count：张量表在 KV 段之后，本函数不解析，读满宽度即可推进

  const kvCountBuf = await cursor.take(8);
  let truncated = kvCountBuf.length < 8;
  const kvCount = kvCountBuf.length >= 8 ? Number(kvCountBuf.readBigUInt64LE(0)) : 0;

  const collected = new Map<string, number | string>();

  for (let i = 0; i < kvCount && !truncated; i++) {
    if (cursor.overBudget) {
      truncated = true;
      break;
    }

    const klenBuf = await cursor.take(8);
    if (klenBuf.length < 8) {
      truncated = true;
      break;
    }
    const klen = Number(klenBuf.readBigUInt64LE(0));

    const keyBuf = await cursor.take(klen);
    if (keyBuf.length < klen) {
      truncated = true;
      break;
    }
    const key = keyBuf.toString("utf8");

    const typeBuf = await cursor.take(4);
    if (typeBuf.length < 4) {
      truncated = true;
      break;
    }
    const type = typeBuf.readUInt32LE(0);

    const ok = await consumeValue(type, cursor, isInterestKey(key), (value) => collected.set(key, value));
    if (!ok) {
      truncated = true;
      break;
    }
  }

  const archValue = collected.get(GGUF_INTEREST.architecture);
  const architecture = typeof archValue === "string" ? archValue : null;

  const fileTypeValue = collected.get(GGUF_INTEREST.fileType);
  const fileType = typeof fileTypeValue === "number" ? fileTypeValue : null;

  const chatTemplateValue = collected.get(GGUF_INTEREST.chatTemplate);
  const chatTemplate = typeof chatTemplateValue === "string" ? chatTemplateValue : null;

  let blockCount: number | null = null;
  let contextLength: number | null = null;
  if (architecture !== null) {
    const bc = collected.get(`${architecture}${GGUF_INTEREST.blockCountSuffix}`);
    const cl = collected.get(`${architecture}${GGUF_INTEREST.contextLengthSuffix}`);
    blockCount = typeof bc === "number" ? bc : null;
    contextLength = typeof cl === "number" ? cl : null;
  }

  return { version, architecture, blockCount, contextLength, fileType, chatTemplate, truncated };
}
