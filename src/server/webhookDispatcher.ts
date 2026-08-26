import type Database from "better-sqlite3";
import { buildWebhookRequest, matchEvent, webhookConfigSchema, type WebhookConfig, type WebhookEvent } from "../core/webhook";
import { makeProxyFetch } from "./hf/client";
import { getPanelConfig } from "./panelConfig";

/**
 * Webhook 出站派发器（UX P1 U24）：与 eventsStream.ts 同款轮询——每 3s 查
 * `id > 游标` 的增量事件，按渠道订阅规则（core/webhook.ts 的 matchEvent）过滤后
 * 出站。事件写入分散在 9 处各自 INSERT INTO events，无统一必经函数，轮询是
 * 唯一能零侵入覆盖全部写入点（含未来新增）的方式。
 *
 * 游标语义（风险簿⑦）：存 settings 表 key=webhook_cursor，面板重启后续推；
 * 首次启用（该 key 不存在）时初始化为当前事件表最大 id，不倒灌历史事件。
 *
 * 防回环（风险簿，PUT /settings/webhooks 的实现说明）：写 settings.webhooks
 * 会记一条 kind="settings.webhook" 的事件，若被当普通事件推送，会在用户每次
 * 保存渠道配置时触发一轮出站——硬编码排除该 kind。
 */

/** 轮询间隔默认值：事件是低频写，3s 感知延迟对通知场景足够 */
export const WEBHOOK_POLL_MS = 3_000;

/** 单次批量上限：防止历史事件积压时一次性打爆出站渠道（风险簿⑧同类考虑） */
export const WEBHOOK_BATCH_LIMIT = 20;

/** 游标存储键（settings 表） */
const CURSOR_KEY = "webhook_cursor";

/** 渠道列表存储键（settings 表，JSON 数组） */
const CONFIGS_KEY = "webhooks";

/** 防回环：保存渠道配置自身产生的事件永不出站，否则「保存配置」会触发一轮推送 */
const LOOPBACK_KIND = "settings.webhook";

/** 出站超时（毫秒）：管理员自填 URL 场景（风险簿⑥），必须有硬上限避免挂死轮询 */
const FETCH_TIMEOUT_MS = 10_000;

/** 读出已保存的渠道列表；脏数据（历史遗留或手工改库）容错为空数组，不拖垮派发器 */
export function loadWebhookConfigs(db: Database.Database): WebhookConfig[] {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(CONFIGS_KEY) as
    | { value: string }
    | undefined;
  if (!row) return [];
  const parsed = webhookConfigSchema.array().safeParse(JSON.parse(row.value));
  return parsed.success ? parsed.data : [];
}

/** 落库渠道列表（upsert，与 hf/settings.ts 的 saveHfMirror 同款写法） */
export function saveWebhookConfigs(db: Database.Database, configs: WebhookConfig[]): void {
  db.prepare(
    `INSERT INTO settings(key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(CONFIGS_KEY, JSON.stringify(configs));
}

function writeCursor(db: Database.Database, value: number): void {
  db.prepare(
    `INSERT INTO settings(key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(CURSOR_KEY, String(value));
}

/**
 * 读取游标；不存在时（首次启用）取当前事件表最大 id 并立即落库——
 * 保证空表重启、或落库前进程崩溃都不会导致下次启动倒灌历史（风险簿⑦）。
 */
function readOrInitCursor(db: Database.Database): number {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(CURSOR_KEY) as
    | { value: string }
    | undefined;
  if (row) return Number(row.value);
  const maxRow = db.prepare("SELECT MAX(id) AS maxId FROM events").get() as { maxId: number | null };
  const initial = maxRow.maxId ?? 0;
  writeCursor(db, initial);
  return initial;
}

/** 出站 fetch 选择：显式注入优先（测试用）；否则按生产规则走代理或裸 fetch */
export function resolveWebhookFetch(fetchImpl?: typeof fetch): typeof fetch {
  if (fetchImpl) return fetchImpl;
  const proxy = getPanelConfig().proxy;
  return proxy ? makeProxyFetch(proxy) : fetch;
}

/**
 * 实际发起一次出站请求（不吞错，调用方决定失败语义）：测试推送需要拿到
 * 状态码回给前端，派发器的批量推送需要吞错继续——两处语义不同，
 * 共用这一层组装+超时+禁止重定向的底层调用。
 */
export async function sendWebhookRequest(
  fetchImpl: typeof fetch,
  config: WebhookConfig,
  event: WebhookEvent,
): Promise<Response> {
  const request = buildWebhookRequest(config, event);
  return fetchImpl(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    redirect: "error", // 风险簿⑥：不跟随重定向到非 http(s) 或内网地址
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

export interface WebhookDispatcherDeps {
  db: Database.Database;
  /** 测试注入假 fetch；生产不传，内部按 resolveWebhookFetch 规则选择 */
  fetchImpl?: typeof fetch;
  /** 轮询间隔（毫秒）；测试注入小值 */
  intervalMs?: number;
}

export interface WebhookDispatcher {
  /** 启动轮询（幂等）；首次调用时确定游标起点 */
  start(): void;
  /** 停止轮询（幂等） */
  stop(): void;
}

export function createWebhookDispatcher(deps: WebhookDispatcherDeps): WebhookDispatcher {
  const fetchFn = resolveWebhookFetch(deps.fetchImpl);
  const interval = deps.intervalMs ?? WEBHOOK_POLL_MS;

  let timer: ReturnType<typeof setInterval> | undefined;
  let cursor = 0;

  async function tick(): Promise<void> {
    const rows = deps.db
      .prepare("SELECT id, ts, kind, message FROM events WHERE id > ? ORDER BY id ASC LIMIT ?")
      .all(cursor, WEBHOOK_BATCH_LIMIT) as WebhookEvent[];
    if (rows.length === 0) return;

    // 每轮重新读取渠道配置：保存渠道设置后无需重启派发器即可在下一轮生效
    const channels = loadWebhookConfigs(deps.db).filter((c) => c.enabled);

    for (const row of rows) {
      if (row.kind === LOOPBACK_KIND) continue; // 防回环：保存配置自身的事件不出站
      for (const channel of channels) {
        if (!matchEvent(channel, row.kind)) continue;
        try {
          await sendWebhookRequest(fetchFn, channel, row);
        } catch (error) {
          // 单渠道失败不阻塞后续事件/渠道：游标仍照常前进（本轮结束统一推进）
          console.warn(`[webhook] 渠道 ${channel.id}（${channel.type}）推送失败:`, error);
        }
      }
    }

    cursor = rows[rows.length - 1].id;
    writeCursor(deps.db, cursor);
  }

  return {
    start() {
      if (timer !== undefined) return; // 幂等，对齐 metrics/collector.ts 的 start()
      cursor = readOrInitCursor(deps.db);
      timer = setInterval(() => void tick(), interval);
    },
    stop() {
      if (timer === undefined) return;
      clearInterval(timer);
      timer = undefined;
    },
  };
}
