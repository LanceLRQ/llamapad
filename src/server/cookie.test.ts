import { describe, expect, it } from "vitest";
import { buildSessionCookie } from "./cookie";

describe("buildSessionCookie：按请求协议决定 Secure", () => {
  const base = { name: "llamapad_session", value: "tok", maxAgeSec: 3600 };

  it("X-Forwarded-Proto: https → 带 Secure", () => {
    const c = buildSessionCookie({ ...base, forwardedProto: "https", requestUrl: "http://panel/api" });
    expect(c).toContain("Secure");
  });

  it("无转发头且请求是 http → 不带 Secure（局域网直连仍能登录）", () => {
    const c = buildSessionCookie({ ...base, forwardedProto: null, requestUrl: "http://192.168.1.10:3000/api" });
    expect(c).not.toContain("Secure");
  });

  it("无转发头但请求本身是 https → 带 Secure", () => {
    const c = buildSessionCookie({ ...base, forwardedProto: null, requestUrl: "https://panel.example.com/api" });
    expect(c).toContain("Secure");
  });

  it("X-Forwarded-Proto 有多值时取第一个（nginx 链式转发）", () => {
    const c = buildSessionCookie({ ...base, forwardedProto: "https, http", requestUrl: "http://panel/api" });
    expect(c).toContain("Secure");
  });

  it("恒带 HttpOnly / Path / SameSite / Max-Age", () => {
    const c = buildSessionCookie({ ...base, forwardedProto: null, requestUrl: "http://panel/api" });
    expect(c).toContain("HttpOnly");
    expect(c).toContain("Path=/");
    expect(c).toContain("SameSite=Lax");
    expect(c).toContain("Max-Age=3600");
  });
});
