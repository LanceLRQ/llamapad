import type Database from "better-sqlite3";
import { open, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { GgufError, parseGguf, type ByteReader, type GgufMeta } from "@/core/gguf";

/**
 * GGUF 元数据服务端缓存（UX P1 U16 后半，迁移 v6 的 gguf_meta 表）
 *
 * 命中条件 = path + size + mtime 三者一致：文件内容变了 mtime 必变（重新下载/
 * 转换等场景），size 作为双保险。缓存永久有效，不设 TTL——GGUF 文件落盘后
 * 极少被原地改写，真正变化时走的是「换一个文件」而不是「改这个文件」。
 */

interface CacheRow {
  size: number;
  mtime: number;
  arch: string | null;
  block_count: number | null;
  context_length: number | null;
  file_type: number | null;
}

/** 缓存行 → GgufMeta：version/truncated 不参与展示与越界判断，缓存表不保留，回填占位值仅为类型对齐 */
function toMeta(row: CacheRow): GgufMeta {
  return {
    version: 0,
    architecture: row.arch,
    blockCount: row.block_count,
    contextLength: row.context_length,
    fileType: row.file_type,
    truncated: false,
  };
}

/**
 * 预读窗口大小：KV 段是顺序扫描，一次多读把逐元素的小读合并成少量 syscall。
 * 64KB 覆盖数千个词表元素的长度头，代价是一次分配。
 */
const READ_WINDOW_BYTES = 64 * 1024;

/**
 * 用真实文件句柄实现 ByteReader，带顺序预读窗口。
 *
 * 没有窗口时每个词表元素的 8 字节长度头都是一次 fh.read——实测
 * SmolLM2-135M（49k 词表）要 98193 次 syscall、耗时 1072ms，而编辑页是
 * server component，这 1 秒直接压在首屏上（大模型词表更长，会到数秒）。
 * 窗口命中时零 syscall，跨窗口才重新填充；请求长度超过窗口（大字符串值）
 * 时按需分配，不受窗口大小限制。
 */
export function fileReader(fh: Pick<FileHandle, "read">): ByteReader {
  let totalRead = 0;
  let win = Buffer.alloc(0);
  let winStart = 0;
  return {
    async read(offset, length) {
      const relative = offset - winStart;
      // 只有窗口完整覆盖请求区间才走缓存，否则重新填充——半覆盖若直接返回短
      // buffer，会被 parseGguf 当成"文件截断"而中止解析
      if (relative >= 0 && relative + length <= win.length) {
        return win.subarray(relative, relative + length);
      }
      const size = Math.max(length, READ_WINDOW_BYTES);
      const buf = Buffer.alloc(size);
      const { bytesRead } = await fh.read(buf, 0, size, offset);
      totalRead += bytesRead;
      win = buf.subarray(0, bytesRead);
      winStart = offset;
      return win.subarray(0, Math.min(length, bytesRead));
    },
    bytesRead() {
      return totalRead;
    },
  };
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * 取 GGUF 元数据：命中缓存直接返回，未命中则实际解析文件并落库。
 * 文件不存在或不是合法 GGUF（magic 不匹配）一律返回 null，不抛——
 * 编辑页据此整段不渲染元数据信息，不能因为一个损坏文件挂掉整页。
 */
export async function getGgufMeta(db: Database.Database, absPath: string): Promise<GgufMeta | null> {
  let stats;
  try {
    stats = await stat(absPath);
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
  const mtime = Math.trunc(stats.mtimeMs);

  const cached = db
    .prepare("SELECT size, mtime, arch, block_count, context_length, file_type FROM gguf_meta WHERE path = ?")
    .get(absPath) as CacheRow | undefined;
  if (cached && cached.size === stats.size && cached.mtime === mtime) {
    return toMeta(cached);
  }

  let fh: FileHandle | undefined;
  let meta: GgufMeta;
  try {
    fh = await open(absPath, "r");
    meta = await parseGguf(fileReader(fh));
  } catch (error) {
    if (isEnoent(error) || error instanceof GgufError) return null;
    throw error;
  } finally {
    await fh?.close();
  }

  db.prepare(
    `INSERT INTO gguf_meta(path, size, mtime, arch, block_count, context_length, file_type, parsed_at)
     VALUES (@path, @size, @mtime, @arch, @blockCount, @contextLength, @fileType, @parsedAt)
     ON CONFLICT(path) DO UPDATE SET
       size = excluded.size,
       mtime = excluded.mtime,
       arch = excluded.arch,
       block_count = excluded.block_count,
       context_length = excluded.context_length,
       file_type = excluded.file_type,
       parsed_at = excluded.parsed_at`,
  ).run({
    path: absPath,
    size: stats.size,
    mtime,
    arch: meta.architecture,
    blockCount: meta.blockCount,
    contextLength: meta.contextLength,
    fileType: meta.fileType,
    parsedAt: Date.now(),
  });

  return meta;
}
