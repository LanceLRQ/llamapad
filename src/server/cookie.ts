/**
 * 会话 cookie 构造（M5，关闭 M4 挂账④）
 *
 * Secure 属性按当前请求的协议自适应，而不是写死：面板自身只跑 HTTP，HTTPS 由 nginx 可选
 * 终止（见 deploy/nginx/README.md）。写死 Secure 会让局域网 HTTP 部署登不进去（浏览器
 * 不回传 Secure cookie）；写死不加则 HTTPS 部署少一层保护。故读 X-Forwarded-Proto，
 * 缺失时回落到请求 URL 自身的协议。
 */

export interface SessionCookieInput {
  name: string;
  value: string;
  maxAgeSec: number;
  /** 请求头 x-forwarded-proto 的原值（可能是 "https" 或 "https, http"）；无则 null */
  forwardedProto: string | null;
  /** 请求 URL，用于在无转发头时判断协议 */
  requestUrl: string;
}

export function buildSessionCookie(input: SessionCookieInput): string {
  const attrs = [
    `${input.name}=${input.value}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${input.maxAgeSec}`,
  ];
  if (isHttps(input)) attrs.push("Secure");
  return attrs.join("; ");
}

function isHttps({ forwardedProto, requestUrl }: SessionCookieInput): boolean {
  if (forwardedProto !== null && forwardedProto.trim() !== "") {
    // 链式代理会累加成 "https, http"，第一个才是最靠近客户端的那一跳
    return forwardedProto.split(",")[0]!.trim().toLowerCase() === "https";
  }
  try {
    return new URL(requestUrl).protocol === "https:";
  } catch {
    return false;
  }
}
