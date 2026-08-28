import type Database from "better-sqlite3";

/**
 * 事件落库助手（UX P1 U23）：给没有自带 record() 的模块（auth 路由等）共用，
 * 与 runtime.ts / download/manager.ts 内部的 record 同一写法。prepared
 * statement 按需构造（对齐 namespaces.ts 的按需构造风格——auth 路由低频，
 * 建设成本可忽略）。
 */
export function recordEvent(db: Database.Database, kind: string, message: string): void {
  db.prepare("INSERT INTO events(ts, kind, message) VALUES (?, ?, ?)").run(Date.now(), kind, message);
}

/**
 * 客户端来源（审计事件消息用）：反代场景取 X-Forwarded-For 首段（链路最左
 * 即原始客户端），无头则「未知来源」——直连部署下 Web 标准 Request 不暴露
 * 对端地址，宁缺毋滥不猜 127.0.0.1。
 */
export function clientSource(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  const first = xff?.split(",")[0]?.trim();
  return first && first.length > 0 ? first : "未知来源";
}

/**
 * 保留窗口（设计文档「events | 事件日志（保留 90 天）」）：ts 落库用毫秒
 * （见上方 recordEvent 的 Date.now()），保留窗口也按毫秒计算，不引入
 * metrics_bucket 那种秒/毫秒换算的心智负担。
 */
const EVENT_RETENTION_MS = 90 * 24 * 3_600_000;

/**
 * 清理超过保留期的事件行：events 只增不减，本函数是唯一的过期出口
 * （对齐设计文档「低频，无需聚合」的定性——不做分桶，直接按时间删）。
 * now 可注入具体毫秒时间戳，测试不依赖真实时钟。
 */
export function pruneExpiredEvents(db: Database.Database, now: number = Date.now()): number {
  return db.prepare("DELETE FROM events WHERE ts < ?").run(now - EVENT_RETENTION_MS).changes;
}

/** 保留期巡检节拍：90 天的窗口不需要比这更密的检查（低频维护任务，无需对齐更细的粒度） */
const EVENT_RETENTION_CHECK_INTERVAL_MS = 6 * 3_600_000;

/** 模块级定时器句柄：同一 bundle 内重复调用 startEventRetentionTimer 时判重 */
let retentionTimer: ReturnType<typeof setInterval> | undefined;

/**
 * 启动 events 保留期定时器：调用时立即跑一轮清理（不必等满 6 小时才第一次
 * 生效），此后按 6 小时节拍重复。now 传函数而非具体值——每次触发都要取
 * 触发时刻的真实时间，与 metrics/store.ts 的 opts.now 用法一致。
 *
 * 幂等仅覆盖同一 bundle：跨 bundle（Next 把 page/route 编译成独立 bundle）
 * 的单例守卫在 locators.ts 用 globalThis 挂载（ensureEventRetentionTimer）。
 */
export function startEventRetentionTimer(db: Database.Database, now: () => number = Date.now): void {
  if (retentionTimer !== undefined) return;
  pruneExpiredEvents(db, now());
  retentionTimer = setInterval(() => pruneExpiredEvents(db, now()), EVENT_RETENTION_CHECK_INTERVAL_MS);
}
