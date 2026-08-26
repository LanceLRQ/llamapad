import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type Database from "better-sqlite3";
import type { WebhookConfig } from "../core/webhook";
import { openDb, runMigrations } from "./db";
import { createWebhookDispatcher, saveWebhookConfigs, type WebhookDispatcher } from "./webhookDispatcher";

/**
 * Webhook 派发器测试（UX P1 U24，TDD）
 *
 * 搭建对齐 metrics/collector.test.ts：:memory: 库 + fake timers 推进轮询节奏；
 * fetch 注入 vi.fn，不做真实网络 IO。db 直接手写 INSERT INTO events 模拟
 * 分散在 9 处的事件写入（本模块的设计前提就是不关心写入方是谁）。
 */

const POLL_MS = 100; // 测试用短间隔，语义与生产 3s 等价，只是加速用例

let db: Database.Database;
let fetchImpl: Mock<typeof fetch>;
let dispatcher: WebhookDispatcher | undefined;

/** 插入一条事件，返回其 id（自增主键） */
function insertEvent(kind: string, message = "msg"): number {
  const info = db.prepare("INSERT INTO events(ts, kind, message) VALUES (?, ?, ?)").run(Date.now(), kind, message);
  return Number(info.lastInsertRowid);
}

/** 保存一个渠道（custom 类型，POST JSON，最省事组装校验用的最小合法配置） */
function channel(overrides: Partial<WebhookConfig> = {}): WebhookConfig {
  return {
    id: "c1",
    type: "custom",
    url: "https://example.com/hook",
    enabled: true,
    kinds: [],
    ...overrides,
  };
}

/** 取某次 fetch 调用的 JSON body（custom 渠道恒为 POST JSON，测试断言用） */
function bodyOf(callIndex: number): { event: { id: number } } {
  const init = fetchImpl.mock.calls[callIndex]![1]!;
  return JSON.parse(init.body as string) as { event: { id: number } };
}

function saveCursor(value: number): void {
  db.prepare(
    `INSERT INTO settings(key, value) VALUES ('webhook_cursor', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(String(value));
}

beforeEach(() => {
  vi.useFakeTimers();
  db = openDb(":memory:");
  runMigrations(db);
  fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
});

afterEach(() => {
  dispatcher?.stop();
  dispatcher = undefined;
  vi.useRealTimers();
  db.close();
});

describe("createWebhookDispatcher", () => {
  it("只推送游标之后的事件", async () => {
    insertEvent("download.complete"); // id=1，落在游标之前
    saveCursor(1);
    const id2 = insertEvent("download.complete"); // id=2，游标之后
    saveWebhookConfigs(db, [channel()]);

    dispatcher = createWebhookDispatcher({ db, fetchImpl, intervalMs: POLL_MS });
    dispatcher.start();
    await vi.advanceTimersByTimeAsync(POLL_MS);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = bodyOf(0);
    expect(body.event.id).toBe(id2);
  });

  it("按 kinds 过滤：只有匹配前缀的事件出站", async () => {
    saveCursor(0);
    insertEvent("model.start");
    const idMatch = insertEvent("download.complete");
    saveWebhookConfigs(db, [channel({ kinds: ["download."] })]);

    dispatcher = createWebhookDispatcher({ db, fetchImpl, intervalMs: POLL_MS });
    dispatcher.start();
    await vi.advanceTimersByTimeAsync(POLL_MS);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = bodyOf(0);
    expect(body.event.id).toBe(idMatch);
  });

  it("禁用的渠道不推送", async () => {
    saveCursor(0);
    insertEvent("download.complete");
    saveWebhookConfigs(db, [channel({ enabled: false })]);

    dispatcher = createWebhookDispatcher({ db, fetchImpl, intervalMs: POLL_MS });
    dispatcher.start();
    await vi.advanceTimersByTimeAsync(POLL_MS);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("出站失败不阻塞后续事件：游标照常前进，仅 console.warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchImpl.mockRejectedValue(new Error("connect refused"));
    saveCursor(0);
    insertEvent("download.complete");
    saveWebhookConfigs(db, [channel()]);

    dispatcher = createWebhookDispatcher({ db, fetchImpl, intervalMs: POLL_MS });
    dispatcher.start();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);

    // 游标已前进：下一条新事件在下一轮仍会被尝试推送（没有被第一条的失败卡住）
    insertEvent("download.complete");
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(2);

    warn.mockRestore();
  });

  it("首次启用从当前最大 id 起，不倒灌历史事件", async () => {
    insertEvent("download.complete"); // 启动前已存在的历史事件
    insertEvent("model.start");
    saveWebhookConfigs(db, [channel()]); // kinds=[] 订阅全部，若倒灌两者都会命中

    dispatcher = createWebhookDispatcher({ db, fetchImpl, intervalMs: POLL_MS });
    dispatcher.start(); // 无游标行：应初始化为当前最大 id（=2），不倒灌
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(fetchImpl).not.toHaveBeenCalled();

    const idNew = insertEvent("download.complete");
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = bodyOf(0);
    expect(body.event.id).toBe(idNew);
  });

  it("单次批量上限 20 条：超量事件分两轮推完", async () => {
    saveCursor(0);
    for (let i = 0; i < 25; i++) insertEvent("download.complete");
    saveWebhookConfigs(db, [channel()]);

    dispatcher = createWebhookDispatcher({ db, fetchImpl, intervalMs: POLL_MS });
    dispatcher.start();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(20);

    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(25);
  });

  it("防回环：settings.webhook 事件本身不出站，但仍推进游标", async () => {
    saveCursor(0);
    insertEvent("settings.webhook", "更新了 webhook 配置");
    const idNext = insertEvent("download.complete");
    saveWebhookConfigs(db, [channel()]);

    dispatcher = createWebhookDispatcher({ db, fetchImpl, intervalMs: POLL_MS });
    dispatcher.start();
    await vi.advanceTimersByTimeAsync(POLL_MS);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = bodyOf(0);
    expect(body.event.id).toBe(idNext);
  });
});
