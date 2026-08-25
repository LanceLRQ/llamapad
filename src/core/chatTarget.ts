/**
 * Chat 页 iframe 目标地址推导（M5，关闭 M4 挂账②）
 *
 * llama.cpp web UI 的 bundle 内含根绝对路径请求，经面板反代必然 404，故改为 iframe 直连
 * llama-server。目标地址两种来源：panel.yaml 的 chat.base_url 显式配置优先；否则按浏览器
 * 当前地址推导——面板与 llama-server 的端口发布在同一台宿主机，所以用户访问面板用的
 * hostname 就是 llama-server 所在的 hostname。
 *
 * mixed content：面板经 nginx 走 HTTPS 时，浏览器会拦截 iframe 里的明文 http 目标。此时
 * 不做无谓尝试（iframe 只会空白），直接给出 blocked 让 UI 提示改配 chat.base_url。
 */

export interface ChatBaseInput {
  /** panel.yaml 的 chat.base_url；未配置为 null */
  configured: string | null;
  /** 浏览器当前 origin（如 http://192.168.1.10:3000） */
  origin: string;
  /** 运行中模型的宿主机端口；无运行模型为 null */
  hostPort: number | null;
}

export type ChatBaseBlocked = "no-port" | "mixed-content" | "bad-origin";

export interface ChatBaseResult {
  /** 可用的 iframe 基地址（无尾斜杠）；不可用为 null */
  url: string | null;
  /** 不可用的原因；可用为 null */
  blocked: ChatBaseBlocked | null;
}

export function resolveChatBase(input: ChatBaseInput): ChatBaseResult {
  let panelProtocol: string;
  let hostname: string;
  try {
    const parsed = new URL(input.origin);
    panelProtocol = parsed.protocol;
    hostname = parsed.hostname;
  } catch {
    return { url: null, blocked: "bad-origin" };
  }

  const target = input.configured !== null && input.configured.trim() !== ""
    ? input.configured.trim().replace(/\/+$/, "")
    : input.hostPort === null
      ? null
      : `http://${hostname}:${input.hostPort}`;

  if (target === null) return { url: null, blocked: "no-port" };

  // 面板在 https 下嵌明文 iframe 会被浏览器拦截，提前判掉而不是让 iframe 空白
  if (panelProtocol === "https:" && target.startsWith("http://")) {
    return { url: null, blocked: "mixed-content" };
  }
  return { url: target, blocked: null };
}
