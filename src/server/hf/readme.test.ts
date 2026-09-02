import { beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";

import { openDb, runMigrations } from "../db";
import { MAX_README_BYTES, PROFILES_ENGINE, getReadme, readReadmeCache } from "./readme";

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

  it("缓存未过期时不打网络，即使已过了一段时间", async () => {
    const spy = vi.fn(() => ok("# Hello"));
    await getReadme(db, "o/r", { hf: {}, fetchImpl: stubFetch(spy) });
    // 离默认 24 小时 TTL 还远：手动把 fetched_at 往前拨一点，模拟「过了一会但没过期」
    db.prepare("UPDATE repo_readme SET fetched_at = ? WHERE repo = ?").run(Date.now() - 1000, "o/r");

    const res = await getReadme(db, "o/r", { hf: {}, fetchImpl: stubFetch(spy) });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(res.content).toBe("# Hello");
  });

  it("缓存过期后即使不传 refresh 也会重新打网络", async () => {
    const spy = vi.fn(() => ok("# v1"));
    await getReadme(db, "o/r", { hf: {}, fetchImpl: stubFetch(spy) });
    // 默认 TTL 24 小时：把 fetched_at 拨到 25 小时前，让它过期
    db.prepare("UPDATE repo_readme SET fetched_at = ? WHERE repo = ?").run(
      Date.now() - 25 * 3_600_000,
      "o/r",
    );

    const res = await getReadme(db, "o/r", { hf: {}, fetchImpl: stubFetch(() => ok("# v2")) });
    expect(res.content).toBe("# v2");
    expect(readReadmeCache(db, "o/r")?.content).toBe("# v2");
  });

  // 这是版本判定挪进早返回之前无法覆盖的场景：以前只有传 refresh 才能触发
  // 重新解析（见上一条用例的历史注释），engine 不一致本身撬不动早返回
  it("profiles_engine 与当前常量不一致时，不传 refresh 也会重新拉取并解析", async () => {
    const md = "```bash\nllama-server --temp 0.6\n```";
    await getReadme(db, "o/r", { hf: {}, fetchImpl: stubFetch(() => ok(md)) });
    db.prepare(`UPDATE repo_readme SET profiles = ?, profiles_engine = 'rules' WHERE repo = ?`).run(
      '[{"id":"stale"}]',
      "o/r",
    );

    const spy = vi.fn(() => ok(md));
    const res = await getReadme(db, "o/r", { hf: {}, fetchImpl: stubFetch(spy) });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(res.profiles!)).not.toEqual([{ id: "stale" }]);
    expect(res.profilesEngine).toBe(PROFILES_ENGINE);
  });

  it("404 缓存（无内容、profiles_engine 为 null）未过期时仍走早返回，不因引擎判定误判为过期", async () => {
    const spy = vi.fn(() => new Response("", { status: 404 }));
    await getReadme(db, "o/r", { hf: {}, fetchImpl: stubFetch(spy) });

    const res = await getReadme(db, "o/r", { hf: {}, fetchImpl: stubFetch(spy) });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(res.content).toBeNull();
  });

  // 曾经的行为是「sha 相同就沿用旧 profiles，哪怕是显式刷新」，但这正是刷新
  // 按钮对推荐卡失效的那个 bug 本身：进入这段重算逻辑的唯一两条路是首次拉取
  // （cached 为 null，天然算不上「沿用」）或显式 refresh（已绕过上面的缓存
  // 早返回）——也就是说“sha 相同就跳过重算”这件事只可能发生在刷新路径上，
  // 而用户点刷新就是想要一次真实的重新解析。所以刷新必须无条件重算，
  // 不能因为内容 sha 没变就沿用旧值。
  it("refresh=true 时即使 sha 与 profiles_engine 都不变也强制重新解析", async () => {
    await getReadme(db, "o/r", { hf: {}, fetchImpl: stubFetch(() => ok("# same")) });
    db.prepare(`UPDATE repo_readme SET profiles = ?, profiles_engine = ? WHERE repo = ?`).run(
      '[{"id":"x"}]',
      PROFILES_ENGINE,
      "o/r",
    );

    // "# same" 本身没有任何推荐参数，真实重算的结果是空数组——不是沿用注入的
    // 旧值 '[{"id":"x"}]'，证明 refresh 确实绕过了「sha 相同就复用」的判断
    await getReadme(db, "o/r", { hf: {}, refresh: true, fetchImpl: stubFetch(() => ok("# same")) });
    expect(readReadmeCache(db, "o/r")?.profiles).toBe("[]");
  });

  it("sha 相同但缓存里的 profiles_engine 是旧版本时，重新解析而不是沿用旧结果", async () => {
    const md = "```bash\nllama-server --temp 0.6\n```";
    await getReadme(db, "o/r", { hf: {}, fetchImpl: stubFetch(() => ok(md)) });
    // 模拟「本仓库在抽取规则升级前就缓存过」：profiles_engine 落的是旧版本号，
    // profiles 是当年旧规则解析出的（这里故意注入一个新规则不会产出的假值）
    // 本用例显式传 refresh，钉住「刷新时强制重算」这条路；引擎版本不一致但不传
    // refresh 也会重新解析——那条路由下面单独一条用例覆盖（早返回现在会检查
    // profilesEngine，见 readme.ts 的 getReadme）
    db.prepare(`UPDATE repo_readme SET profiles = ?, profiles_engine = 'rules' WHERE repo = ?`).run(
      '[{"id":"stale"}]',
      "o/r",
    );

    const res = await getReadme(db, "o/r", { hf: {}, refresh: true, fetchImpl: stubFetch(() => ok(md)) });
    expect(JSON.parse(res.profiles!)).not.toEqual([{ id: "stale" }]);
    expect(res.profilesEngine).toBe(PROFILES_ENGINE);
  });

  it("内容变了不沿用旧 profiles，当场用新内容重新解析", async () => {
    await getReadme(db, "o/r", { hf: {}, fetchImpl: stubFetch(() => ok("# v1")) });
    db.prepare("UPDATE repo_readme SET profiles = ? WHERE repo = ?").run('[{"id":"x"}]', "o/r");

    await getReadme(db, "o/r", { hf: {}, refresh: true, fetchImpl: stubFetch(() => ok("# v2")) });
    // "# v2" 没有任何推荐参数，重新解析后应为空数组——不是沿用旧缓存的 [{"id":"x"}]，
    // 也不再是 null（抽取器接入前，变更内容只能把 profiles 清空占位）
    expect(readReadmeCache(db, "o/r")?.profiles).toBe("[]");
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

  it("拉取成功后当场解析出 profiles", async () => {
    const md = "---\nlicense: mit\n---\n\n## Best Practices\n- Thinking: `temperature=0.6`, `top_p=0.95`";
    const res = await getReadme(db, "o/r", { hf: {}, fetchImpl: stubFetch(() => ok(md)) });

    const profiles = JSON.parse(res.profiles!) as { server: Record<string, number> }[];
    expect(profiles[0].server).toEqual({ temp: 0.6, top_p: 0.95 });
    expect(res.profilesEngine).toBe(PROFILES_ENGINE);
  });

  it("没有推荐参数时 profiles 是空数组而不是 null", async () => {
    const res = await getReadme(db, "o/r", { hf: {}, fetchImpl: stubFetch(() => ok("# 只有标题")) });
    expect(JSON.parse(res.profiles!)).toEqual([]);
  });
});
