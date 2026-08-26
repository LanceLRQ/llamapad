import { describe, expect, it } from "vitest";
import { buildWebhookRequest, matchEvent, webhookConfigSchema } from "./webhook";

const ev = { id: 7, ts: 1_700_000_000_000, kind: "download.complete", message: "模型 qwen3 下载完成" };

describe("buildWebhookRequest", () => {
  it("bark：URL 拼 title/body 路径段并转义", () => {
    const r = buildWebhookRequest({ id: "1", type: "bark", url: "https://api.day.app/KEY", enabled: true, kinds: [] }, ev);
    expect(r.method).toBe("GET");
    expect(r.url).toBe("https://api.day.app/KEY/llamapad/%E6%A8%A1%E5%9E%8B%20qwen3%20%E4%B8%8B%E8%BD%BD%E5%AE%8C%E6%88%90");
  });
  it("telegram：POST JSON 带 chat_id", () => {
    const r = buildWebhookRequest({ id: "1", type: "telegram", url: "https://api.telegram.org/botTOKEN/sendMessage", token: "12345", enabled: true, kinds: [] }, ev);
    expect(r.method).toBe("POST");
    expect(JSON.parse(r.body!)).toEqual({ chat_id: "12345", text: "llamapad: 模型 qwen3 下载完成" });
  });
  it("wecom：markdown 结构", () => {
    const r = buildWebhookRequest({ id: "1", type: "wecom", url: "https://qyapi.weixin.qq.com/x", enabled: true, kinds: [] }, ev);
    expect(JSON.parse(r.body!)).toMatchObject({ msgtype: "markdown" });
  });
  it("custom：原样 POST 事件 JSON", () => {
    const r = buildWebhookRequest({ id: "1", type: "custom", url: "https://example.com/hook", enabled: true, kinds: [] }, ev);
    expect(JSON.parse(r.body!)).toEqual({ source: "llamapad", event: ev });
  });
});

describe("matchEvent", () => {
  it("kinds 为空表示订阅全部", () => {
    expect(matchEvent({ kinds: [] }, "model.start")).toBe(true);
  });
  it("前缀匹配", () => {
    expect(matchEvent({ kinds: ["download."] }, "download.complete")).toBe(true);
    expect(matchEvent({ kinds: ["download."] }, "model.start")).toBe(false);
  });
});

describe("webhookConfigSchema", () => {
  it("拒绝非 http(s) 协议（SSRF 面收敛）", () => {
    expect(webhookConfigSchema.safeParse({ id: "1", type: "custom", url: "file:///etc/passwd", enabled: true, kinds: [] }).success).toBe(false);
  });
  it("接受 https URL", () => {
    expect(webhookConfigSchema.safeParse({ id: "1", type: "custom", url: "https://a.com/h", enabled: true, kinds: [] }).success).toBe(true);
  });
});
