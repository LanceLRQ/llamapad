import { z } from "zod";

/**
 * Webhook 通知渠道纯逻辑（UX P1 U24）：渠道配置 schema + 四渠道 payload 构造 +
 * 订阅匹配。本文件不含任何 IO（不碰 db/fetch），server/webhookDispatcher.ts
 * 负责轮询取事件、按此处的 matchEvent 过滤、用 buildWebhookRequest 组装
 * 请求后实际出站。
 *
 * 渠道类型：
 * - bark：iOS 推送 App，GET 请求，URL 路径拼 /标题/正文（需转义）
 * - telegram：Bot API，POST JSON，token 字段存 chat_id
 * - wecom：企业微信群机器人，POST markdown 消息
 * - custom：用户自建接收端，POST 原样事件 JSON（source 标识来源）
 */

/** 渠道配置：id 由前端生成（lib/uuid.randomId，见该文件注释——HTTP 局域网下
 * crypto.randomUUID 不可用，需回退），kinds 为空数组表示订阅全部事件 */
export const webhookConfigSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["bark", "telegram", "wecom", "custom"]),
  // 手工校验协议而非依赖 z.url() 的默认行为：SSRF 面收敛必须显式拒绝 file:/ftp: 等
  // 非 http(s) 协议（风险簿⑥），写法与 server/hf/settings.ts 的 parseHfMirror 一致
  url: z.string().refine((value) => {
    try {
      const protocol = new URL(value).protocol;
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  }, "url 必须是合法的 http(s) 地址"),
  /** telegram 存 chat_id；bark/wecom/custom 不需要 */
  token: z.string().optional(),
  enabled: z.boolean(),
  /** 订阅的事件 kind 前缀数组（如 "download."）；空数组=订阅全部 */
  kinds: z.array(z.string()),
});

export type WebhookConfig = z.infer<typeof webhookConfigSchema>;

/** events 表一行（与 eventsStream.ts 的 EventRow 同构，本层不依赖 server 模块自行定义） */
export interface WebhookEvent {
  id: number;
  ts: number;
  kind: string;
  message: string;
}

/** buildWebhookRequest 的产物：dispatcher 与测试推送共用同一份组装结果去发起 fetch */
export interface WebhookRequest {
  method: "GET" | "POST";
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

/** 订阅匹配：kinds 为空表示订阅全部；否则按前缀匹配（"download." 匹配 "download.complete"） */
export function matchEvent(config: { kinds: string[] }, kind: string): boolean {
  if (config.kinds.length === 0) return true;
  return config.kinds.some((prefix) => kind.startsWith(prefix));
}

/** 按渠道类型组装出站请求（纯函数，不发请求） */
export function buildWebhookRequest(config: WebhookConfig, event: WebhookEvent): WebhookRequest {
  switch (config.type) {
    case "bark": {
      // Bark 的推送内容走 URL 路径段（GET），标题固定为 llamapad，正文为事件消息
      const title = encodeURIComponent("llamapad");
      const body = encodeURIComponent(event.message);
      return { method: "GET", url: `${config.url}/${title}/${body}` };
    }
    case "telegram": {
      return {
        method: "POST",
        url: config.url,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: config.token, text: `llamapad: ${event.message}` }),
      };
    }
    case "wecom": {
      return {
        method: "POST",
        url: config.url,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          msgtype: "markdown",
          markdown: { content: `**llamapad**\n> ${event.message}` },
        }),
      };
    }
    case "custom": {
      return {
        method: "POST",
        url: config.url,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "llamapad", event }),
      };
    }
  }
}
