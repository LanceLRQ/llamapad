import { beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";

import { openDb, runMigrations } from "../db";
import { getReadme, readLlmCache, saveLlmCache } from "../hf/readme";
import type { ExtractEngine } from "./engine";
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
    expect(out.result.profiles[0]!.server).toEqual({ temp: 0.6 });
    expect(JSON.parse(readLlmCache(db, "o/r")!.profiles!)).toHaveLength(1);
    expect(readLlmCache(db, "o/r")!.model).toBe("fake-model");
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

    expect((err as { kind?: string }).kind).toBe("badResponse");
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
});

/** 取当前 README 的 content_sha，供上面那条断言用 */
function readReadmeCacheSha(database: Database.Database): string {
  const row = database.prepare("SELECT content_sha FROM repo_readme WHERE repo = 'o/r'").get() as {
    content_sha: string;
  };
  return row.content_sha;
}
