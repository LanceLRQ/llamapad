import { beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";

import { openDb, runMigrations } from "../db";
import { getReadme, readLlmCache, saveLlmCache } from "../hf/readme";
import { LlmError, type ExtractEngine } from "./engine";
import { runExtract } from "./extract";

let db: Database.Database;

const BODY = "Set the temperature to 0.6 for best results. Use top_p 0.95.";

beforeEach(async () => {
  db = openDb(":memory:");
  runMigrations(db);
  await getReadme(db, "o/r", {
    hf: {},
    fetchImpl: (() => Promise.resolve(new Response(BODY, { status: 200 }))) as unknown as typeof fetch,
  });
});

/** 一个只会吐固定文本的假引擎 */
function fakeEngine(output: string, model = "fake-model"): ExtractEngine {
  return {
    id: "external",
    model,
    run: ({ onDelta }) => {
      onDelta({ kind: "content", text: output });
      return Promise.resolve(output);
    },
  };
}

/** 一个只会抛错的假引擎 */
function rejectingEngine(error: unknown, model = "fake-model"): ExtractEngine {
  return {
    id: "external",
    model,
    run: () => Promise.reject(error),
  };
}

describe("runExtract", () => {
  it("回证通过的字段落进结果，并首次直接落库", async () => {
    const out = await runExtract({
      db,
      repo: "o/r",
      engine: fakeEngine('{"profiles":[{"label":"R","params":{"temp":0.6}}]}'),
      signal: new AbortController().signal,
      onDelta: vi.fn(),
    });

    expect(out.hadPrevious).toBe(false);
    expect(out.repaired).toBe(false);
    expect(out.result.profiles[0]!.server).toEqual({ temp: 0.6 });
    expect(JSON.parse(readLlmCache(db, "o/r")!.profiles!)).toHaveLength(1);
    expect(readLlmCache(db, "o/r")!.model).toBe("fake-model");
  });

  // 本任务的回归：模型输出被截断（最外层 } 没吐出来）时，编排层要把
  // repaired 如实透传给调用方（SSE 路由要往前端推），而不是悄悄吞掉
  it("模型输出被截断但有完整元素时，丢弃末尾不完整的一条并标 repaired", async () => {
    const out = await runExtract({
      db,
      repo: "o/r",
      engine: fakeEngine('{"profiles":[{"label":"R","params":{"temp":0.6}}]'),
      signal: new AbortController().signal,
      onDelta: vi.fn(),
    });

    expect(out.repaired).toBe(true);
    expect(out.result.profiles[0]!.server).toEqual({ temp: 0.6 });
    expect(JSON.parse(readLlmCache(db, "o/r")!.profiles!)).toHaveLength(1);
  });

  // D3：重跑不落库，交给用户在对比弹层里决定
  it("已有旧结果时不落库，只回结果并标 hadPrevious", async () => {
    saveLlmCache(db, "o/r", { profiles: '[{"id":"old"}]', engine: "local", model: "old-model", contentSha: "x" });

    const out = await runExtract({
      db,
      repo: "o/r",
      engine: fakeEngine('{"profiles":[{"label":"R","params":{"temp":0.6}}]}'),
      signal: new AbortController().signal,
      onDelta: vi.fn(),
    });

    expect(out.hadPrevious).toBe(true);
    expect(JSON.parse(readLlmCache(db, "o/r")!.profiles!)).toEqual([{ id: "old" }]);
  });

  it("模型吐不出合法 JSON → badResponse，不落库", async () => {
    const err = await runExtract({
      db,
      repo: "o/r",
      engine: fakeEngine("在英文句子中，要抠出 temperature…"),
      signal: new AbortController().signal,
      onDelta: vi.fn(),
    }).catch((e: unknown) => e);

    expect((err as { kind?: string }).kind).toBe("badResponse");
    expect(readLlmCache(db, "o/r")!.profiles).toBeNull();
  });

  // 「AI 没找到」不是错误：跑通了、原文里确实没有，这是正常结果，要落库
  it("解析成功但一套都没抠到 → 正常返回空结果并落库", async () => {
    const out = await runExtract({
      db,
      repo: "o/r",
      engine: fakeEngine('{"profiles":[]}'),
      signal: new AbortController().signal,
      onDelta: vi.fn(),
    });

    expect(out.result.profiles).toEqual([]);
    expect(readLlmCache(db, "o/r")!.profiles).toBe("[]");
  });

  it("落库的 contentSha 取当前 README 的 sha，供 UI 判过期", async () => {
    await runExtract({
      db,
      repo: "o/r",
      engine: fakeEngine('{"profiles":[{"label":"R","params":{"temp":0.6}}]}'),
      signal: new AbortController().signal,
      onDelta: vi.fn(),
    });

    const llm = readLlmCache(db, "o/r")!;
    expect(llm.contentSha).toBe(readReadmeCacheSha(db));
  });

  it("README 没拉过时拒绝，不去打网络", async () => {
    const err = await runExtract({
      db,
      repo: "never/fetched",
      engine: fakeEngine("{}"),
      signal: new AbortController().signal,
      onDelta: vi.fn(),
    }).catch((e: unknown) => e);

    // 最终审查③：这条曾经落在笼统的 badResponse 上，导致前端把「这个仓库没有
    // README」显示成「模型输出无法解析，换一个大一点的模型试试」——指向了错误
    // 的处置方式。现在有专门的 noReadme kind
    expect((err as { kind?: string }).kind).toBe("noReadme");
  });

  it("增量原样透传给调用方（SSE 路由要往前端推）", async () => {
    const onDelta = vi.fn();
    await runExtract({
      db,
      repo: "o/r",
      engine: fakeEngine('{"profiles":[]}'),
      signal: new AbortController().signal,
      onDelta,
    });

    expect(onDelta).toHaveBeenCalledWith({ kind: "content", text: '{"profiles":[]}' });
  });

  // 编排层是"失败伪装成成功"的最后一道关：引擎抛的 LlmError 必须原样穿透，
  // 谁要是在这里加一层 try/catch 吞成空结果，这条测试就该变红
  it("引擎抛 LlmError 时原样上抛，不吞成空结果", async () => {
    await expect(
      runExtract({
        db,
        repo: "o/r",
        engine: rejectingEngine(new LlmError("rateLimited", "服务商限流，稍后重试")),
        signal: new AbortController().signal,
        onDelta: vi.fn(),
      }),
    ).rejects.toMatchObject({ kind: "rateLimited" });

    expect(readLlmCache(db, "o/r")!.profiles).toBeNull();
  });

  it("引擎抛非 LlmError 的异常时同样不落库", async () => {
    await expect(
      runExtract({
        db,
        repo: "o/r",
        engine: rejectingEngine(new Error("网络中断")),
        signal: new AbortController().signal,
        onDelta: vi.fn(),
      }),
    ).rejects.toThrow("网络中断");

    expect(readLlmCache(db, "o/r")!.profiles).toBeNull();
  });

  // 「模型给了字段但全被闸门丢掉」与「模型压根没给字段」是两件不同的事，
  // 它们走同一条落库路径，但 offered/dropped 必须如实透传，UI 才能分别提示
  it("字段全被闸门丢弃时 offered 大于 0、dropped 大于 0，照常落库", async () => {
    const out = await runExtract({
      db,
      repo: "o/r",
      // temp: 0.9 能识别成字段（offered++），但 BODY 里只有 0.6 / 0.95，
      // 回证不到，所以又被丢弃（dropped++），最终 profiles 仍是空数组
      engine: fakeEngine('{"profiles":[{"label":"R","params":{"temp":0.9}}]}'),
      signal: new AbortController().signal,
      onDelta: vi.fn(),
    });

    expect(out.result.profiles).toEqual([]);
    expect(out.result.offered).toBeGreaterThan(0);
    expect(out.result.dropped).toBeGreaterThan(0);
    expect(readLlmCache(db, "o/r")!.profiles).toBe("[]");
  });

  it("模型压根没给字段时 offered 与 dropped 都是 0，照常落库", async () => {
    const out = await runExtract({
      db,
      repo: "o/r",
      engine: fakeEngine('{"profiles":[]}'),
      signal: new AbortController().signal,
      onDelta: vi.fn(),
    });

    expect(out.result.profiles).toEqual([]);
    expect(out.result.offered).toBe(0);
    expect(out.result.dropped).toBe(0);
    expect(readLlmCache(db, "o/r")!.profiles).toBe("[]");
  });
});

/** 取当前 README 的 content_sha，供上面那条断言用 */
function readReadmeCacheSha(database: Database.Database): string {
  const row = database.prepare("SELECT content_sha FROM repo_readme WHERE repo = 'o/r'").get() as {
    content_sha: string;
  };
  return row.content_sha;
}
