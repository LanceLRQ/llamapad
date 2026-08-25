/**
 * 客户端统一 API 入口（UX P0 Task 2 / U13）：在原生 fetch 外补两件全局语义，
 * 其余行为（Response 原样返回、错误仍由调用方内联展示）不变。
 *
 * 1. 401 统一处理：会话过期（7 天 cookie）不再表现为各页面莫名的内联报错，
 *    而是整页跳登录并带 expired=1 + next=<当前路径>，登录后回跳原页；
 *    认证端点自身（login/setup/logout）豁免——401 在那里是业务语义（密码错误）。
 * 2. 连接状态喂入：网络层异常 / 成功往返写 connection-store（断线横幅消费，
 *    见 ConnectionBanner）。
 */

import { connectionStore } from "./connection-store";

/** 401 视为"会话过期"而非业务错误的路由（认证自身） */
const AUTH_EXEMPT_PREFIXES = ["/api/v1/auth/login", "/api/v1/auth/setup", "/api/v1/auth/logout"];

export function isAuthExemptPath(path: string): boolean {
  const route = path.split("?")[0]!;
  return AUTH_EXEMPT_PREFIXES.some((prefix) => route === prefix || route.startsWith(`${prefix}/`));
}

/** 会话过期跳转目标：/login?expired=1&next=<原路径>（login 自身不带 next） */
export function buildSessionExpiredRedirect(pathname: string): string {
  const params = new URLSearchParams({ expired: "1" });
  if (pathname && pathname !== "/login") params.set("next", pathname);
  return `/login?${params.toString()}`;
}

/**
 * 登录后回跳目标清洗：只接受站内路径（防 open redirect）。
 * 非法输入（外链、协议相对、login 自身、空值）返回 null → 落回 "/"。
 */
export function sanitizeNextPath(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("://")) return null;
  if (raw === "/login" || raw.startsWith("/login?") || raw.startsWith("/login/")) return null;
  return raw;
}

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    connectionStore.reportRequestFailure();
    throw error;
  }
  connectionStore.reportRequestSuccess();
  if (response.status === 401 && !isAuthExemptPath(path) && typeof window !== "undefined") {
    window.location.assign(buildSessionExpiredRedirect(window.location.pathname + window.location.search));
  }
  return response;
}
