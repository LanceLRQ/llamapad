import { describe, expect, it } from "vitest";
import { buildCurlSnippet, formatStartedAt, originFromHeaders, relayBaseUrls } from "./relay-snippet";

function headers(map: Record<string, string>) {
  return (key: string) => map[key] ?? null;
}

describe("originFromHeaders", () => {
  it("直连：用 host，协议缺省 http", () => {
    expect(originFromHeaders(headers({ host: "10.0.0.5:28960" }))).toBe("http://10.0.0.5:28960");
  });

  it("经反代：x-forwarded-* 优先，多值取第一个", () => {
    expect(
      originFromHeaders(
        headers({ host: "127.0.0.1:28960", "x-forwarded-host": "pad.example.com, inner", "x-forwarded-proto": "https,http" }),
      ),
    ).toBe("https://pad.example.com");
  });

  it("没有任何 host → 空串", () => {
    expect(originFromHeaders(headers({}))).toBe("");
  });
});

describe("relayBaseUrls", () => {
  it("短地址与长地址都以 /v1 结尾，origin 末尾斜杠被去掉", () => {
    expect(relayBaseUrls("http://h:1/")).toEqual({
      short: "http://h:1/llama-proxy/v1",
      long: "http://h:1/api/v1/proxy/llama/v1",
    });
  });
});

describe("buildCurlSnippet", () => {
  it("预填模型名", () => {
    const text = buildCurlSnippet("http://h:1/llama-proxy/v1", "qwen");
    expect(text).toContain("curl http://h:1/llama-proxy/v1/chat/completions");
    expect(text).toContain('"model":"qwen"');
    expect(text).toContain("Authorization: Bearer lp_xxxxxxxx");
  });

  it("没有默认模型时用占位名", () => {
    expect(buildCurlSnippet("http://h:1/llama-proxy/v1", null)).toContain('"model":"your-model"');
  });
});

describe("formatStartedAt", () => {
  it("ISO → 固定的 UTC 文本（不依赖运行环境时区）", () => {
    expect(formatStartedAt("2026-10-11T03:04:05.678Z")).toBe("2026-10-11 03:04:05 UTC");
  });

  it("null 或解析不了 → null", () => {
    expect(formatStartedAt(null)).toBeNull();
    expect(formatStartedAt("nope")).toBeNull();
  });
});
