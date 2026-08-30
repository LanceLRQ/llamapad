/**
 * llama UI 外链地址推导（M5 引入直连，自建 Playground 任务 7 改为外链语义）
 *
 * llama.cpp 自带 web UI 原先内嵌 iframe 直连 llama-server；Chat 页改用面板自建
 * Playground 后，它降级为页头的一个新窗口外链按钮。目标地址两种来源：panel.yaml
 * 的 chat.base_url 显式配置优先；否则按浏览器当前地址推导——面板与 llama-server
 * 的端口发布在同一台宿主机，所以用户访问面板用的 hostname 就是 llama-server
 * 所在的 hostname。
 *
 * 不拦 mixed content：这是一次浏览器导航（新窗口打开），不是页面内子资源加载，
 * https 页面跳转到 http 目标不受 mixed content 限制，无需提前判掉。
 */

export interface WebuiUrlInput {
  /** panel.yaml 的 chat.base_url；未配置为 null */
  configured: string | null;
  /** 浏览器当前 origin（如 http://192.168.1.10:3000） */
  origin: string;
  /** 运行中模型的宿主机端口；无运行模型为 null */
  hostPort: number | null;
}

export type WebuiUrlBlocked = "no-port" | "bad-origin";

export interface WebuiUrlResult {
  /** 可用的外链地址（无尾斜杠）；不可用为 null */
  url: string | null;
  /** 不可用的原因；可用为 null */
  blocked: WebuiUrlBlocked | null;
}

export function resolveWebuiUrl(input: WebuiUrlInput): WebuiUrlResult {
  let hostname: string;
  try {
    hostname = new URL(input.origin).hostname;
  } catch {
    return { url: null, blocked: "bad-origin" };
  }

  const target = input.configured !== null && input.configured.trim() !== ""
    ? input.configured.trim().replace(/\/+$/, "")
    : input.hostPort === null
      ? null
      : `http://${hostname}:${input.hostPort}`;

  if (target === null) return { url: null, blocked: "no-port" };

  return { url: target, blocked: null };
}
