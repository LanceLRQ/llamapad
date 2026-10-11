import { describe, expect, it } from "vitest";
import { keyTail, normalizeUpstreamBaseUrl, upstreamNameProblem } from "./upstream-url";

describe("normalizeUpstreamBaseUrl", () => {
  it("去掉末尾斜杠、/v1、query 与 hash", () => {
    expect(normalizeUpstreamBaseUrl("http://10.0.0.5:8080")).toEqual({ ok: true, url: "http://10.0.0.5:8080" });
    expect(normalizeUpstreamBaseUrl(" http://10.0.0.5:8080/ ")).toEqual({ ok: true, url: "http://10.0.0.5:8080" });
    expect(normalizeUpstreamBaseUrl("http://10.0.0.5:8080/v1/")).toEqual({ ok: true, url: "http://10.0.0.5:8080" });
    expect(normalizeUpstreamBaseUrl("https://api.example.com/V1?x=1#y")).toEqual({
      ok: true,
      url: "https://api.example.com",
    });
  });

  it("保留 /v1 之前的路径前缀", () => {
    expect(normalizeUpstreamBaseUrl("https://api.example.com/compatible-mode/v1")).toEqual({
      ok: true,
      url: "https://api.example.com/compatible-mode",
    });
  });

  it("丢弃地址里的用户名密码", () => {
    expect(normalizeUpstreamBaseUrl("http://user:pass@h:1/v1")).toEqual({ ok: true, url: "http://h:1" });
  });

  it("非 http(s) 协议与解析不了的输入被拒绝", () => {
    expect(normalizeUpstreamBaseUrl("ftp://h/")).toEqual({ ok: false, reason: "protocol" });
    expect(normalizeUpstreamBaseUrl("file:///etc/passwd")).toEqual({ ok: false, reason: "protocol" });
    expect(normalizeUpstreamBaseUrl("10.0.0.5:8080")).toEqual({ ok: false, reason: "protocol" });
    expect(normalizeUpstreamBaseUrl("")).toEqual({ ok: false, reason: "invalid" });
    expect(normalizeUpstreamBaseUrl("not a url")).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("upstreamNameProblem", () => {
  it("合法名字 → null", () => {
    expect(upstreamNameProblem("strata-v100")).toBeNull();
  });

  it("格式不对 / 保留名", () => {
    expect(upstreamNameProblem("")).toBe("format");
    expect(upstreamNameProblem("Strata")).toBe("format");
    expect(upstreamNameProblem("-a")).toBe("format");
    expect(upstreamNameProblem("a_b")).toBe("format");
    expect(upstreamNameProblem("test")).toBe("reserved");
    expect(upstreamNameProblem("probe")).toBe("reserved");
  });
});

describe("keyTail", () => {
  it("取尾 4 位；空值为 null", () => {
    expect(keyTail("sk-abcdef")).toBe("cdef");
    expect(keyTail("ab")).toBe("ab");
    expect(keyTail(null)).toBeNull();
    expect(keyTail("")).toBeNull();
  });
});
