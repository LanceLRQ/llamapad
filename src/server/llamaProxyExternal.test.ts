import { describe, expect, it } from "vitest";
import {
  buildExternalRequest,
  sanitizeExternalResponse,
  stripForwardingHeaders,
} from "./llamaProxy";

function panelRequest(path: string, init: RequestInit = {}): Request {
  return new Request(`http://panel.test${path}`, init);
}

const dirty = {
  cookie: "llamapad_session=abc",
  authorization: "Bearer lp_client",
  "x-forwarded-for": "1.2.3.4",
  "x-forwarded-host": "panel.example",
  "x-forwarded-proto": "https",
  "x-forwarded-port": "443",
  forwarded: "for=1.2.3.4",
  "x-real-ip": "1.2.3.4",
  "proxy-authorization": "Basic eA==",
  "x-keep": "yes",
};

describe("stripForwardingHeaders：转发链头", () => {
  it("删掉 x-forwarded-* / forwarded / x-real-ip / proxy-authorization，其余保留", () => {
    const headers = new Headers(dirty);
    stripForwardingHeaders(headers);
    expect([...headers.keys()].sort()).toEqual(["authorization", "cookie", "x-keep"]);
  });
});

describe("buildExternalRequest：发往外部上游的请求", () => {
  const post = (body: string) =>
    panelRequest("/api/v1/proxy/llama/v1/chat/completions", {
      method: "POST",
      headers: { ...dirty, "content-type": "application/json" },
      body,
    });

  it("不带客户端的 authorization / cookie，也不带转发链头", () => {
    const { url, init } = buildExternalRequest(post("{}"), "http://up:1", ["v1", "chat", "completions"], "{}", {
      upstreamModel: null,
      apiKey: null,
    });
    const headers = init.headers as Headers;
    expect(url).toBe("http://up:1/v1/chat/completions");
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("x-forwarded-for")).toBeNull();
    expect(headers.get("x-forwarded-host")).toBeNull();
    expect(headers.get("x-forwarded-proto")).toBeNull();
    expect(headers.get("forwarded")).toBeNull();
    expect(headers.get("x-real-ip")).toBeNull();
    expect(headers.get("proxy-authorization")).toBeNull();
    expect(headers.get("x-keep")).toBe("yes");
  });

  it("有密钥时注入 Bearer，且替换而非叠加客户端的", () => {
    const { init } = buildExternalRequest(post("{}"), "http://up:1", [], "{}", {
      upstreamModel: null,
      apiKey: "sk-up",
    });
    expect((init.headers as Headers).get("authorization")).toBe("Bearer sk-up");
  });

  it("upstreamModel 非空时改写 model，为空时请求体原样", () => {
    const raw = '{"model":"strata","x":1}';
    const rewritten = buildExternalRequest(post(raw), "http://up:1", [], raw, { upstreamModel: "Real-1", apiKey: null });
    expect(JSON.parse(rewritten.init.body as string)).toEqual({ model: "Real-1", x: 1 });
    const same = buildExternalRequest(post(raw), "http://up:1", [], raw, { upstreamModel: null, apiKey: null });
    expect(same.init.body).toBe(raw);
  });
});

describe("buildExternalRequest：显式传入的模型名", () => {
  const post = (body: string) =>
    panelRequest("/api/v1/proxy/llama/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

  it("别名请求：传入的模型名写进请求体，其余字段保留", () => {
    const raw = '{"model":"gpt-4.1","stream":true}';
    const { init } = buildExternalRequest(post(raw), "http://up:1", [], raw, { upstreamModel: "target-a", apiKey: null });
    expect(JSON.parse(init.body as string)).toEqual({ model: "target-a", stream: true });
  });

  it("为 null 时请求体原样（别名本身透传）", () => {
    const raw = '{"model":"gpt-4.1"}';
    const { init } = buildExternalRequest(post(raw), "http://up:1", [], raw, { upstreamModel: null, apiKey: null });
    expect(init.body).toBe(raw);
  });
});

describe("sanitizeExternalResponse：外部上游响应", () => {
  it("删 set-cookie（含多条），加 CSP sandbox 与 nosniff，状态码与其余头保留", async () => {
    const upstream = new Response("<script>1</script>", { status: 201, statusText: "Created" });
    upstream.headers.append("set-cookie", "llamapad_session=evil; Path=/");
    upstream.headers.append("set-cookie", "b=2");
    upstream.headers.set("content-type", "text/html");
    upstream.headers.set("x-up", "1");
    upstream.headers.set("content-security-policy", "default-src *");
    const out = sanitizeExternalResponse(upstream);
    expect(out.status).toBe(201);
    expect(out.headers.get("set-cookie")).toBeNull();
    expect(out.headers.get("content-security-policy")).toBe("sandbox");
    expect(out.headers.get("x-content-type-options")).toBe("nosniff");
    expect(out.headers.get("content-type")).toBe("text/html");
    expect(out.headers.get("x-up")).toBe("1");
    expect(await out.text()).toBe("<script>1</script>");
  });

  it("body 仍是原流，不缓冲", () => {
    const stream = new ReadableStream();
    const out = sanitizeExternalResponse(new Response(stream));
    expect(out.body).toBeInstanceOf(ReadableStream);
  });
});
