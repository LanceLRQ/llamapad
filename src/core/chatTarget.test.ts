import { describe, expect, it } from "vitest";
import { resolveWebuiUrl } from "./chatTarget";

describe("resolveWebuiUrl：llama UI 外链地址推导", () => {
  it("配置了 base_url 时原样使用（去掉尾斜杠）", () => {
    expect(resolveWebuiUrl({ configured: "https://llama-api.example.com/", origin: "https://panel.example.com", hostPort: 18080 }))
      .toEqual({ url: "https://llama-api.example.com", blocked: null });
  });

  it("未配置 + 面板走 http → 按 hostname 与 host_port 推导", () => {
    expect(resolveWebuiUrl({ configured: null, origin: "http://192.168.1.10:3000", hostPort: 18080 }))
      .toEqual({ url: "http://192.168.1.10:18080", blocked: null });
  });

  it("面板走 https 时仍返回明文外链（导航不受 mixed content 限制）", () => {
    expect(resolveWebuiUrl({ configured: null, origin: "https://panel.example", hostPort: 18080 }))
      .toEqual({ url: "http://panel.example:18080", blocked: null });
  });

  it("没有运行中模型的 host_port → 无目标", () => {
    expect(resolveWebuiUrl({ configured: null, origin: "http://192.168.1.10:3000", hostPort: null }))
      .toEqual({ url: null, blocked: "no-port" });
  });
});
