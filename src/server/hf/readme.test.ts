import { beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";

import { openDb, runMigrations } from "../db";
import { MAX_README_BYTES, getReadme, readReadmeCache } from "./readme";

let db: Database.Database;

beforeEach(() => {
  db = openDb(":memory:");
  runMigrations(db);
});

/** 造一个 fetch 桩：按 URL 回不同响应 */
function stubFetch(handler: (url: string) => Response): typeof fetch {
  return ((input: RequestInfo | URL) =>
    Promise.resolve(handler(String(input)))) as unknown as typeof fetch;
}

const ok = (body: string) => new Response(body, { status: 200 });

describe("getReadme", () => {
  it("首次拉取写入缓存并回内容", async () => {
    const fetchImpl = stubFetch(() => ok("# Hello"));
    const res = await getReadme(db, "o/r", { hf: {}, fetchImpl });

    expect(res.content).toBe("# Hello");
    expect(res.error).toBeNull();
    expect(res.truncated).toBe(false);
    expect(readReadmeCache(db, "o/r")?.content).toBe("# Hello");
  });

  it("命中缓存时不再打网络", async () => {
    const spy = vi.fn(() => ok("# Hello"));
    await getReadme(db, "o/r", { hf: {}, fetchImpl: stubFetch(spy) });
    await getReadme(db, "o/r", { hf: {}, fetchImpl: stubFetch(spy) });

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("refresh=true 绕过缓存", async () => {
    const spy = vi.fn(() => ok("# v1"));
    await getReadme(db, "o/r", { hf: {}, fetchImpl: stubFetch(spy) });
    const res = await getReadme(db, "o/r", {
      hf: {},
      refresh: true,
      fetchImpl: stubFetch(() => ok("# v2")),
    });

    expect(res.content).toBe("# v2");
    expect(readReadmeCache(db, "o/r")?.content).toBe("# v2");
  });

  it("内容未变时保留已解析的 profiles（sha 相同不该白白重算）", async () => {
    await getReadme(db, "o/r", { hf: {}, fetchImpl: stubFetch(() => ok("# same")) });
    db.prepare("UPDATE repo_readme SET profiles = ?, profiles_engine = 'rules' WHERE repo = ?").run(
      '[{"id":"x"}]',
      "o/r",
    );

    await getReadme(db, "o/r", { hf: {}, refresh: true, fetchImpl: stubFetch(() => ok("# same")) });
    expect(readReadmeCache(db, "o/r")?.profiles).toBe('[{"id":"x"}]');
  });

  it("内容变了让 profiles 失效", async () => {
    await getReadme(db, "o/r", { hf: {}, fetchImpl: stubFetch(() => ok("# v1")) });
    db.prepare("UPDATE repo_readme SET profiles = ? WHERE repo = ?").run('[{"id":"x"}]', "o/r");

    await getReadme(db, "o/r", { hf: {}, refresh: true, fetchImpl: stubFetch(() => ok("# v2")) });
    expect(readReadmeCache(db, "o/r")?.profiles).toBeNull();
  });

  it("404 落一行 content=NULL —— 「问过了，确实没有」，下次不再打网络", async () => {
    const spy = vi.fn(() => new Response("", { status: 404 }));
    const res = await getReadme(db, "o/r", { hf: {}, fetchImpl: stubFetch(spy) });

    expect(res.content).toBeNull();
    expect(res.error).toEqual({ kind: "notFound", message: expect.any(String) });

    const row = db.prepare("SELECT * FROM repo_readme WHERE repo = ?").get("o/r");
    expect(row).toBeDefined();

    await getReadme(db, "o/r", { hf: {}, fetchImpl: stubFetch(spy) });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("401 不落库 —— 用户去设置页填了 Token 后，下次进页面要能自动重试", async () => {
    const res = await getReadme(db, "o/r", {
      hf: {},
      fetchImpl: stubFetch(() => new Response("", { status: 401 })),
    });

    expect(res.error?.kind).toBe("unauthorized");
    expect(readReadmeCache(db, "o/r")).toBeNull();
  });

  it("403 同样归入 unauthorized", async () => {
    const res = await getReadme(db, "o/r", {
      hf: {},
      fetchImpl: stubFetch(() => new Response("", { status: 403 })),
    });
    expect(res.error?.kind).toBe("unauthorized");
  });

  it("网络异常不落库，且带出旧缓存内容", async () => {
    await getReadme(db, "o/r", { hf: {}, fetchImpl: stubFetch(() => ok("# cached")) });

    const failing = (() => Promise.reject(new Error("boom"))) as unknown as typeof fetch;
    const res = await getReadme(db, "o/r", { hf: {}, refresh: true, fetchImpl: failing });

    expect(res.error?.kind).toBe("network");
    expect(res.content).toBe("# cached");
    expect(readReadmeCache(db, "o/r")?.content).toBe("# cached");
  });

  it("500 归入 network（可重试），不是 notFound", async () => {
    const res = await getReadme(db, "o/r", {
      hf: {},
      fetchImpl: stubFetch(() => new Response("", { status: 500 })),
    });
    expect(res.error?.kind).toBe("network");
  });

  it("超长内容截断并打标", async () => {
    const huge = "x".repeat(MAX_README_BYTES + 1024);
    const res = await getReadme(db, "o/r", { hf: {}, fetchImpl: stubFetch(() => ok(huge)) });

    expect(res.truncated).toBe(true);
    expect(res.content?.length).toBeLessThanOrEqual(MAX_README_BYTES);
  });

  it("按镜像端点与 Token 组装请求", async () => {
    let seenUrl = "";
    let seenAuth: string | null = null;
    const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(input);
      seenAuth = new Headers(init?.headers).get("authorization");
      return Promise.resolve(ok("# ok"));
    }) as unknown as typeof fetch;

    await getReadme(db, "o/r", {
      hf: { endpoint: "https://hf-mirror.com", token: "hf_abc" },
      fetchImpl,
    });

    expect(seenUrl).toBe("https://hf-mirror.com/o/r/resolve/main/README.md");
    expect(seenAuth).toBe("Bearer hf_abc");
  });

  it("未配置 Token 时不带 Authorization 头", async () => {
    let seenAuth: string | null = "unset";
    const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
      seenAuth = new Headers(init?.headers).get("authorization");
      return Promise.resolve(ok("# ok"));
    }) as unknown as typeof fetch;

    await getReadme(db, "o/r", { hf: {}, fetchImpl });
    expect(seenAuth).toBeNull();
  });
});
