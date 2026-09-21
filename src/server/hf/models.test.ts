import { HubApiError } from "@huggingface/hub";
import { beforeEach, describe, expect, it } from "vitest";

import type { ModelEntryWithExtras } from "@/lib/hf-models";
import {
  _resetTrendingCacheForTest,
  getTrendingModels,
  searchModels,
  type ListModelsFn,
} from "./models";

beforeEach(() => {
  _resetTrendingCacheForTest();
});

const entry = (name: string): ModelEntryWithExtras => ({
  name,
  likes: 10,
  downloads: 100,
  gated: false,
  task: "text-generation",
  updatedAt: new Date("2026-09-17T00:00:00.000Z"),
  trendingScore: 5,
});

/** 造一个产出 n 条的假 listModels；同时记录每次收到的参数供断言 */
function fakeList(names: string[]): ListModelsFn & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  // 直接标注声明类型而非事后 `as` 转换——单步 `as` 到"调用签名 + 属性"的交叉类型会被
  // tsc 判定两边重叠不足（TS2352），此处按 metrics/nvidiaSmi.test.ts 的 fakeExec 同款写法
  const fn: ListModelsFn & { calls: Record<string, unknown>[] } = (params: Record<string, unknown>) => {
    calls.push(params);
    return (async function* () {
      for (const n of names) yield entry(n);
    })();
  };
  fn.calls = calls;
  return fn;
}

function failingList(error: unknown): ListModelsFn {
  return (() =>
    (async function* () {
      throw error;
      yield entry("never");
    })()) as ListModelsFn;
}

describe("getTrendingModels", () => {
  it("首次取落缓存并回内容", async () => {
    const list = fakeList(["a/b"]);
    const res = await getTrendingModels({ hf: {}, limit: 12, now: 1000, listModels: list });

    expect(res.items.map((i) => i.repo)).toEqual(["a/b"]);
    expect(res.fetchedAt).toBe(1000);
    expect(res.stale).toBe(false);
    expect(res.error).toBeNull();
  });

  it("按 gguf 标签与 trendingScore 排序请求，并要 trendingScore 这个附加字段", async () => {
    const list = fakeList(["a/b"]);
    await getTrendingModels({ hf: {}, limit: 12, now: 1000, listModels: list });

    expect(list.calls[0]).toMatchObject({
      sort: "trendingScore",
      limit: 12,
      search: { tags: ["gguf"] },
      additionalFields: ["trendingScore"],
    });
  });

  it("TTL 内再取不打网络", async () => {
    const list = fakeList(["a/b"]);
    await getTrendingModels({ hf: {}, limit: 12, now: 1000, listModels: list });
    const res = await getTrendingModels({ hf: {}, limit: 12, now: 2000, listModels: list });

    expect(list.calls).toHaveLength(1);
    expect(res.items.map((i) => i.repo)).toEqual(["a/b"]);
    expect(res.stale).toBe(false);
  });

  it("TTL 外再取重新请求并更新 fetchedAt", async () => {
    const list = fakeList(["a/b"]);
    await getTrendingModels({ hf: {}, limit: 12, now: 1000, listModels: list });
    const later = 1000 + 31 * 60_000;
    const res = await getTrendingModels({ hf: {}, limit: 12, now: later, listModels: list });

    expect(list.calls).toHaveLength(2);
    expect(res.fetchedAt).toBe(later);
  });

  it("refresh 强制绕过未过期的缓存", async () => {
    const list = fakeList(["a/b"]);
    await getTrendingModels({ hf: {}, limit: 12, now: 1000, listModels: list });
    const res = await getTrendingModels({
      hf: {},
      limit: 12,
      now: 1500,
      refresh: true,
      listModels: list,
    });

    expect(list.calls).toHaveLength(2);
    expect(res.fetchedAt).toBe(1500);
  });

  it("取数失败且有旧缓存：回落旧值、标 stale、带中文原因，且旧缓存不被清空", async () => {
    const ok = fakeList(["a/b"]);
    await getTrendingModels({ hf: {}, limit: 12, now: 1000, listModels: ok });

    const bad = failingList(new HubApiError("rate limited", 429));
    const res = await getTrendingModels({
      hf: {},
      limit: 12,
      now: 2000,
      refresh: true,
      listModels: bad,
    });

    expect(res.items.map((i) => i.repo)).toEqual(["a/b"]);
    expect(res.fetchedAt).toBe(1000);
    expect(res.stale).toBe(true);
    expect(res.error).toBe("HF 限流，建议配置 Token 或稍后重试");

    // 失败不许把用户正看着的榜单弄没
    const again = await getTrendingModels({ hf: {}, limit: 12, now: 2100, listModels: ok });
    expect(again.items.map((i) => i.repo)).toEqual(["a/b"]);
  });

  it("取数失败且无缓存：空数组 + error，交由 route 转 502", async () => {
    const res = await getTrendingModels({
      hf: {},
      limit: 12,
      now: 1000,
      listModels: failingList(new Error("fetch failed")),
    });

    expect(res.items).toEqual([]);
    expect(res.fetchedAt).toBe(0);
    expect(res.error).toBe("HF 网络错误: fetch failed");
  });

  it("404 的文案是端点提示，不是「仓库不存在」", async () => {
    const res = await getTrendingModels({
      hf: {},
      limit: 12,
      now: 1000,
      listModels: failingList(new HubApiError("not found", 404)),
    });

    expect(res.error).toBe("HF 接口不存在，请检查设置页的镜像端点");
  });

  it("缓存按端点隔离：换镜像端点不会命中官方站的缓存", async () => {
    const official = fakeList(["official/x"]);
    const mirror = fakeList(["mirror/y"]);
    await getTrendingModels({ hf: {}, limit: 12, now: 1000, listModels: official });
    const res = await getTrendingModels({
      hf: { endpoint: "https://hf-mirror.com" },
      limit: 12,
      now: 1000,
      listModels: mirror,
    });

    expect(res.items.map((i) => i.repo)).toEqual(["mirror/y"]);
    expect(mirror.calls).toHaveLength(1);
  });

  it("limit 截断：远端给多了也只留 limit 条", async () => {
    const many = Array.from({ length: 30 }, (_, i) => `o/r${i}`);
    const res = await getTrendingModels({
      hf: {},
      limit: 12,
      now: 1000,
      listModels: fakeList(many),
    });

    expect(res.items).toHaveLength(12);
  });
});

describe("searchModels", () => {
  it("带查询词请求且不写缓存（不污染热门榜）", async () => {
    const search = fakeList(["s/one"]);
    const trending = fakeList(["t/one"]);

    const res = await searchModels("qwen3", { hf: {}, limit: 12, now: 1000, listModels: search });
    expect(res.items.map((i) => i.repo)).toEqual(["s/one"]);
    expect(res.fetchedAt).toBe(0);
    expect(search.calls[0]).toMatchObject({ search: { tags: ["gguf"], query: "qwen3" } });

    const after = await getTrendingModels({ hf: {}, limit: 12, now: 1000, listModels: trending });
    expect(after.items.map((i) => i.repo)).toEqual(["t/one"]);
  });

  it("失败时空数组 + 中文原因", async () => {
    const res = await searchModels("qwen3", {
      hf: {},
      limit: 12,
      now: 1000,
      // HubApiError 构造签名是 (url, statusCode, requestId?, message?)——message 在第 4 位，
      // 不是第 1 位；这里要断言的是 mapHfError 把 e.message 拼进第五档文案
      listModels: failingList(new HubApiError("https://huggingface.co/api/models", 500, undefined, "boom")),
    });

    expect(res.items).toEqual([]);
    expect(res.error).toBe("HF API 错误(HTTP 500): boom");
  });
});
