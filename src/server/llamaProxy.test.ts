import { describe, expect, it } from "vitest";
import { llamaUpstreamBase } from "./llamaProxy";
import {
  buildProxyRequest,
  buildUpstreamPath,
  sanitizeUpstreamResponse,
} from "./llamaProxy";

/**
 * Playground 反代纯函数测试（M3 Task 6，TDD）：
 * route 薄壳（鉴权 + getRunningContainerInfo + fetch 转发）不单测，
 * header 清洗矩阵、URL 拼接、query 保留、空 path、流式 body 透传全部收敛在这里覆盖；
 * 端到端（真 fetch + 本地 node 服务器）走任务内手工验证（curl -N 逐块到达）。
 */

/** 造一个"面板侧收到"的请求（源 = 面板源，header/body 模拟浏览器或 curl 发来的） */
function panelRequest(path: string, init: RequestInit = {}): Request {
  return new Request(`http://panel.test${path}`, init);
}

describe("llamaUpstreamBase：上游地址构造（M4 真机：面板容器内 127.0.0.1 不通）", () => {
  it("默认 127.0.0.1（Mac 开发 / 宿主直跑场景）", () => {
    expect(llamaUpstreamBase(18080)).toBe("http://127.0.0.1:18080");
  });

  it("PANEL_LLAMA_HOST 覆盖（容器化部署指向宿主机，如 host.docker.internal）", () => {
    process.env.PANEL_LLAMA_HOST = "host.docker.internal";
    try {
      expect(llamaUpstreamBase(18080)).toBe("http://host.docker.internal:18080");
    } finally {
      delete process.env.PANEL_LLAMA_HOST;
    }
  });
});

describe("buildUpstreamPath：URL 路径拼接", () => {
  it.each<[string, string[] | undefined, string, string]>([
    ["根路径（无段）", undefined, "", "/"],
    ["空数组", [], "", "/"],
    ["Next 可选 catch-all 的空串段", [""], "", "/"],
    ["单段", ["sse"], "", "/sse"],
    ["多段拼接", ["v1", "chat", "completions"], "", "/v1/chat/completions"],
  ])("%s", (_name, segments, search, expected) => {
    expect(buildUpstreamPath(segments, search)).toBe(expected);
  });

  it("query 原样保留（含 & 与 =）", () => {
    expect(buildUpstreamPath(["props"], "?a=1&b=%20x")).toBe("/props?a=1&b=%20x");
  });

  it("段内特殊字符被重新编码（Next 解码后的段不能裸拼 URL）", () => {
    expect(buildUpstreamPath(["a b"], "")).toBe("/a%20b");
  });
});

describe("buildProxyRequest：请求侧清洗与转发头", () => {
  it("URL = targetBase + 拼接路径 + 原始 query", () => {
    const { url } = buildProxyRequest(
      panelRequest("/api/v1/proxy/llama/sse?stream=1"),
      "http://127.0.0.1:8080",
      ["sse"],
    );
    expect(url).toBe("http://127.0.0.1:8080/sse?stream=1");
  });

  it("空 path 打到上游根", () => {
    const { url } = buildProxyRequest(panelRequest("/api/v1/proxy/llama"), "http://127.0.0.1:99", undefined);
    expect(url).toBe("http://127.0.0.1:99/");
  });

  it.each([
    "host",
    "connection",
    "content-length",
    "transfer-encoding",
    "keep-alive",
    "upgrade",
    "proxy-connection",
    "te",
    "trailer",
    "cookie",
    "authorization",
    "x-llamapad-trace",
  ])("剔除 %s（hop-by-hop / 长度重算 / 面板凭证与自身头）", (header) => {
    const { init } = buildProxyRequest(
      panelRequest("/api/v1/proxy/llama/x", { headers: { [header]: "whatever" } }),
      "http://127.0.0.1:1",
      ["x"],
    );
    expect(new Headers(init.headers).get(header)).toBeNull();
  });

  it("保留普通业务头（content-type / accept / user-agent）", () => {
    const { init } = buildProxyRequest(
      panelRequest("/api/v1/proxy/llama/x", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          "user-agent": "curl/8",
        },
        body: "{}",
      }),
      "http://127.0.0.1:1",
      ["x"],
    );
    const headers = new Headers(init.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("accept")).toBe("text/event-stream");
    expect(headers.get("user-agent")).toBe("curl/8");
  });

  it("accept-encoding 强制 identity（防上游压缩后 undici 解压导致 content-length 失配）", () => {
    const { init } = buildProxyRequest(
      panelRequest("/api/v1/proxy/llama/x", { headers: { "accept-encoding": "gzip, br" } }),
      "http://127.0.0.1:1",
      ["x"],
    );
    expect(new Headers(init.headers).get("accept-encoding")).toBe("identity");
  });

  it("补 x-forwarded-for：无既有值时为 127.0.0.1", () => {
    const { init } = buildProxyRequest(panelRequest("/api/v1/proxy/llama/x"), "http://127.0.0.1:1", ["x"]);
    expect(new Headers(init.headers).get("x-forwarded-for")).toBe("127.0.0.1");
  });

  it("补 x-forwarded-for：已有值时追加（链式代理语义）", () => {
    const { init } = buildProxyRequest(
      panelRequest("/api/v1/proxy/llama/x", { headers: { "x-forwarded-for": "203.0.113.9" } }),
      "http://127.0.0.1:1",
      ["x"],
    );
    expect(new Headers(init.headers).get("x-forwarded-for")).toBe("203.0.113.9, 127.0.0.1");
  });

  it("补 x-forwarded-host（客户端访问面板用的原始 host）", () => {
    const { init } = buildProxyRequest(
      panelRequest("/api/v1/proxy/llama/x", { headers: { host: "llamapad.example:8081" } }),
      "http://127.0.0.1:1",
      ["x"],
    );
    const headers = new Headers(init.headers);
    expect(headers.get("host")).toBeNull();
    expect(headers.get("x-forwarded-host")).toBe("llamapad.example:8081");
  });

  it("x-forwarded-proto：缺省补 http，已有值保留", () => {
    const a = buildProxyRequest(panelRequest("/api/v1/proxy/llama/x"), "http://127.0.0.1:1", ["x"]);
    expect(new Headers(a.init.headers).get("x-forwarded-proto")).toBe("http");

    const b = buildProxyRequest(
      panelRequest("/api/v1/proxy/llama/x", { headers: { "x-forwarded-proto": "https" } }),
      "http://127.0.0.1:1",
      ["x"],
    );
    expect(new Headers(b.init.headers).get("x-forwarded-proto")).toBe("https");
  });

  it.each(["GET", "HEAD"])("%s 不带请求体（undici 流式 body 仅用于有体的方法）", async (method) => {
    const { init } = buildProxyRequest(panelRequest("/api/v1/proxy/llama/", { method }), "http://127.0.0.1:1", []);
    expect(init.body).toBeUndefined();
    expect(init.method).toBe(method);
  });

  it("POST：请求体以流透传（duplex half）+ redirect manual + 方法保留", async () => {
    const { init, url } = buildProxyRequest(
      panelRequest("/api/v1/proxy/llama/completion", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "hi" }),
      }),
      "http://127.0.0.1:8080",
      ["completion"],
    );
    expect(url).toBe("http://127.0.0.1:8080/completion");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    // body 必须是原请求的流对象（而非缓冲后的副本）
    expect(init.body).toBeInstanceOf(ReadableStream);
    expect((init as RequestInit & { duplex?: string }).duplex).toBe("half");
    // 读流得到原始内容（证明流未被消费/替换）
    const text = await new Response(init.body).text();
    expect(JSON.parse(text as string)).toEqual({ prompt: "hi" });
  });
});

describe("sanitizeUpstreamResponse：响应侧清洗", () => {
  it("剔除 hop-by-hop（transfer-encoding/connection/keep-alive/upgrade）", () => {
    const upstream = new Response("ok", {
      headers: {
        "content-type": "text/html",
        "transfer-encoding": "chunked",
        connection: "keep-alive",
        "keep-alive": "timeout=5",
        upgrade: "websocket",
      },
    });
    const headers = sanitizeUpstreamResponse(upstream).headers;
    expect(headers.get("transfer-encoding")).toBeNull();
    expect(headers.get("connection")).toBeNull();
    expect(headers.get("keep-alive")).toBeNull();
    expect(headers.get("upgrade")).toBeNull();
  });

  it("保留 content-type / content-encoding / content-length 原样（identity 下安全）", () => {
    const upstream = new Response("body", {
      headers: {
        "content-type": "text/event-stream",
        "content-encoding": "identity",
        "content-length": "4",
        "cache-control": "no-cache",
      },
    });
    const headers = sanitizeUpstreamResponse(upstream).headers;
    expect(headers.get("content-type")).toBe("text/event-stream");
    expect(headers.get("content-encoding")).toBe("identity");
    expect(headers.get("content-length")).toBe("4");
    expect(headers.get("cache-control")).toBe("no-cache");
  });

  it("status 与 statusText 透传", () => {
    const sanitized = sanitizeUpstreamResponse(new Response("nope", { status: 404, statusText: "Not Found" }));
    expect(sanitized.status).toBe(404);
    expect(sanitized.statusText).toBe("Not Found");
  });

  it("响应体以流透传（不缓冲）", async () => {
    const chunks = ["data: 1\n\n", "data: 2\n\n"];
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });
    const sanitized = sanitizeUpstreamResponse(new Response(stream, { headers: { "content-type": "text/event-stream" } }));
    expect(sanitized.body).toBeInstanceOf(ReadableStream);
    expect(await sanitized.text()).toBe(chunks.join(""));
  });

  it.each([204, 304])("%s（无体状态）不因构造带体 Response 而抛错", (status) => {
    const sanitized = sanitizeUpstreamResponse(
      new Response(null, { status, headers: { "content-type": "text/plain" } }),
    );
    expect(sanitized.status).toBe(status);
    expect(sanitized.body).toBeNull();
  });
});
