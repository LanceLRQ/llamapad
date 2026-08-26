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
