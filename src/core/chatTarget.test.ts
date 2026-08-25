import { describe, expect, it } from "vitest";
import { resolveChatBase } from "./chatTarget";

describe("resolveChatBase：Chat iframe 目标地址推导", () => {
  it("配置了 base_url 时原样使用（去掉尾斜杠）", () => {
    expect(resolveChatBase({ configured: "https://llama-api.example.com/", origin: "https://panel.example.com", hostPort: 18080 }))
      .toEqual({ url: "https://llama-api.example.com", blocked: null });
  });

  it("未配置 + 面板走 http → 按 hostname 与 host_port 推导", () => {
    expect(resolveChatBase({ configured: null, origin: "http://192.168.1.10:3000", hostPort: 18080 }))
      .toEqual({ url: "http://192.168.1.10:18080", blocked: null });
  });

  it("未配置 + 面板走 https → 拒绝推导（明文直连会被 mixed content 拦截），要求显式配置", () => {
    expect(resolveChatBase({ configured: null, origin: "https://panel.example.com", hostPort: 18080 }))
      .toEqual({ url: null, blocked: "mixed-content" });
  });

  it("配置了 http base_url 但面板走 https → 同样拦截", () => {
    expect(resolveChatBase({ configured: "http://192.168.1.10:18080", origin: "https://panel.example.com", hostPort: 18080 }))
      .toEqual({ url: null, blocked: "mixed-content" });
  });

  it("没有运行中模型的 host_port → 无目标", () => {
    expect(resolveChatBase({ configured: null, origin: "http://192.168.1.10:3000", hostPort: null }))
      .toEqual({ url: null, blocked: "no-port" });
  });
});
