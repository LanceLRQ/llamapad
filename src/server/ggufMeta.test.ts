import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import type { FileHandle } from "node:fs/promises";
import { parseGguf } from "@/core/gguf";
import { buildGguf } from "@/core/gguf.testkit";
import { openDb, runMigrations } from "./db";
import { fileReader, getGgufMeta } from "./ggufMeta";

/**
 * getGgufMeta 测试（真实文件系统 + 内存 sqlite，不 mock fs——对齐 fsScanner.test.ts 惯例）
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "llamapad-ggufmeta-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeDb(): Database.Database {
  const db = openDb(":memory:");
  runMigrations(db);
  return db;
}

describe("getGgufMeta", () => {
  it("首次解析落库", async () => {
    const abs = path.join(dir, "model.gguf");
    writeFileSync(
      abs,
      buildGguf([
        ["general.architecture", { t: 8, v: "llama" }],
        ["general.file_type", { t: 4, v: 15 }],
        ["llama.block_count", { t: 4, v: 32 }],
        ["llama.context_length", { t: 4, v: 8192 }],
      ]),
    );
    const db = makeDb();

    const meta = await getGgufMeta(db, abs);

    expect(meta).toMatchObject({
      architecture: "llama",
      blockCount: 32,
      contextLength: 8192,
      fileType: 15,
    });
    const row = db.prepare("SELECT * FROM gguf_meta WHERE path = ?").get(abs);
    expect(row).toBeTruthy();
  });

  it("二次命中缓存（不重新落库，parsed_at 不推进）", async () => {
    const abs = path.join(dir, "model.gguf");
    writeFileSync(abs, buildGguf([["general.architecture", { t: 8, v: "llama" }]]));
    const db = makeDb();

    const first = await getGgufMeta(db, abs);
    const parsedAt1 = (
      db.prepare("SELECT parsed_at FROM gguf_meta WHERE path = ?").get(abs) as { parsed_at: number }
    ).parsed_at;

    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await getGgufMeta(db, abs);
    const parsedAt2 = (
      db.prepare("SELECT parsed_at FROM gguf_meta WHERE path = ?").get(abs) as { parsed_at: number }
    ).parsed_at;

    // version/truncated 不进缓存表（只是类型对齐的占位值），比对聚焦缓存真正保留的字段
    expect(second).toMatchObject({
      architecture: first?.architecture,
      blockCount: first?.blockCount,
      contextLength: first?.contextLength,
      fileType: first?.fileType,
    });
    expect(parsedAt2).toBe(parsedAt1);
  });

  it("mtime 变化后重新解析", async () => {
    const abs = path.join(dir, "model.gguf");
    writeFileSync(abs, buildGguf([["general.architecture", { t: 8, v: "llama" }]]));
    const db = makeDb();

    const first = await getGgufMeta(db, abs);
    expect(first?.architecture).toBe("llama");

    writeFileSync(abs, buildGguf([["general.architecture", { t: 8, v: "qwen2" }]]));
    const future = new Date(Date.now() + 5000);
    utimesSync(abs, future, future);

    const second = await getGgufMeta(db, abs);
    expect(second?.architecture).toBe("qwen2");
  });

  it("文件不存在返回 null 不抛", async () => {
    const db = makeDb();
    await expect(getGgufMeta(db, path.join(dir, "never-existed.gguf"))).resolves.toBeNull();
  });

});

/**
 * 词表每个元素的 8 字节长度头都必须读，无预读窗口时就是每个元素一次 syscall：
 * 实测 SmolLM2-135M（49k 词表）98193 次读、耗时 1072ms，而编辑页是 server
 * component，这 1 秒直接压在首屏上。加 64KB 窗口后同一文件降到 40ms。
 * 下面用假 FileHandle 数实际读次数，钉死窗口不被改回逐次读。
 */
describe("fileReader 预读窗口", () => {
  /** 用内存 Buffer 假扮文件句柄，只实现 parseGguf 用到的 read，并计数 */
  function countingHandle(data: Buffer) {
    let calls = 0;
    return {
      calls: () => calls,
      handle: {
        async read(buf: Buffer, offset: number, length: number, position: number) {
          calls += 1;
          const slice = data.subarray(position, Math.min(position + length, data.length));
          slice.copy(buf, offset);
          return { bytesRead: slice.length, buffer: buf };
        },
      },
    };
  }

  it("两万元素词表只触发两位数量级的实际读", async () => {
    const tokens = Array.from({ length: 20_000 }, (_, i) => `tok_${i}`);
    const data = buildGguf([
      ["tokenizer.ggml.tokens", { t: 9, v: [8, tokens] }],
      ["general.architecture", { t: 8, v: "llama" }],
      ["llama.block_count", { t: 4, v: 24 }],
    ]);
    const { handle, calls } = countingHandle(data);

    const meta = await parseGguf(fileReader(handle as unknown as Pick<FileHandle, "read">));

    expect(meta.blockCount).toBe(24);
    // 逐元素读法至少 20000 次；64KB 窗口下文件才 300KB 出头，应是几十次
    expect(calls()).toBeLessThan(200);
  });

  it("跨窗口边界的请求返回完整字节而非被截断的短 buffer", async () => {
    // 构造让某个值恰好横跨 64KB 边界的文件：若半覆盖时直接返回短 buffer，
    // parseGguf 会误判文件截断并中止，architecture 就读不到了
    const filler = "y".repeat(70_000);
    const data = buildGguf([
      ["padding.blob", { t: 8, v: filler }],
      ["general.architecture", { t: 8, v: "gemma" }],
      ["gemma.block_count", { t: 4, v: 18 }],
    ]);
    const { handle } = countingHandle(data);

    const meta = await parseGguf(fileReader(handle as unknown as Pick<FileHandle, "read">));

    expect(meta).toMatchObject({ architecture: "gemma", blockCount: 18, truncated: false });
  });
});
