import { describe, expect, it, vi } from "vitest";

import { LlmError } from "./engine";
import { createExternalEngine } from "./external";

const CONFIG = {
  baseUrl: "https://api.example.com/v1",
  apiKey: "sk-secret",
  model: "test-model",
  extraBody: null,
};

/** 造一条 SSE 流响应 */
function sseResponse(lines: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(new TextEncoder().encode(`${line}\n`));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const frame = (delta: Record<string, unknown>) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}`;

function run(engine: ReturnType<typeof createExternalEngine>, onDelta = vi.fn()) {
  return engine.run({ text: "README 片段", signal: new AbortController().signal, onDelta });
}

describe("createExternalEngine 请求形状", () => {
  it("打到 baseUrl + /chat/completions，带 Bearer 与 stream", async () => {
    const doFetch = vi.fn(() => Promise.resolve(sseResponse(["data: [DONE]"])));
    await run(createExternalEngine(CONFIG, doFetch as unknown as typeof fetch));

    const [url, init] = doFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example.com/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-secret");

    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.model).toBe("test-model");
    expect(body.stream).toBe(true);
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("extraBody 合并进请求体", async () => {
    const doFetch = vi.fn(() => Promise.resolve(sseResponse(["data: [DONE]"])));
    await run(
      createExternalEngine(
        { ...CONFIG, extraBody: { thinking: { type: "disabled" } } },
        doFetch as unknown as typeof fetch,
      ),
    );

    const body = JSON.parse(String((doFetch.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.thinking).toEqual({ type: "disabled" });
  });

  it("面板字段覆盖 extraBody 里的同名字段", async () => {
    const doFetch = vi.fn(() => Promise.resolve(sseResponse(["data: [DONE]"])));
    await run(
      createExternalEngine(
        { ...CONFIG, extraBody: { model: "用户想换的", stream: false } },
        doFetch as unknown as typeof fetch,
      ),
    );

    const body = JSON.parse(String((doFetch.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.model).toBe("test-model");
    expect(body.stream).toBe(true);
  });
});

describe("createExternalEngine 流式累积", () => {
  it("累积 content 增量并作为返回值", async () => {
    const doFetch = () =>
      Promise.resolve(
        sseResponse([
          frame({ role: "assistant", content: '{"pro' }),
          "",
          frame({ content: 'files":[]}' }),
          "data: [DONE]",
        ]),
      );

    const text = await run(createExternalEngine(CONFIG, doFetch as unknown as typeof fetch));
    expect(text).toBe('{"profiles":[]}');
  });

  it("reasoning 与 content 分开回调，正文里不混进思考", async () => {
    const onDelta = vi.fn();
    const doFetch = () =>
      Promise.resolve(
        sseResponse([
          frame({ reasoning_content: "让我想想" }),
          frame({ content: "{}" }),
          "data: [DONE]",
        ]),
      );

    const text = await run(createExternalEngine(CONFIG, doFetch as unknown as typeof fetch), onDelta);

    expect(text).toBe("{}");
    expect(onDelta).toHaveBeenCalledWith({ kind: "reasoning", text: "让我想想" });
    expect(onDelta).toHaveBeenCalledWith({ kind: "content", text: "{}" });
  });
});

describe("createExternalEngine 错误分类", () => {
  // 实测形态：限流走 HTTP 200 + JSON error 体，不是 4xx
  it("HTTP 200 但返回 JSON error 体 → rateLimited", async () => {
    const doFetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { code: "1305", message: "该模型当前访问量过大，请您稍后再试" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    const err = await run(createExternalEngine(CONFIG, doFetch as unknown as typeof fetch)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).kind).toBe("rateLimited");
  });

  it("HTTP 429 → rateLimited", async () => {
    const doFetch = () => Promise.resolve(new Response("{}", { status: 429 }));
    const err = await run(createExternalEngine(CONFIG, doFetch as unknown as typeof fetch)).catch((e: unknown) => e);
    expect((err as LlmError).kind).toBe("rateLimited");
  });

  it("HTTP 401 → unauthorized", async () => {
    const doFetch = () => Promise.resolve(new Response("{}", { status: 401 }));
    const err = await run(createExternalEngine(CONFIG, doFetch as unknown as typeof fetch)).catch((e: unknown) => e);
    expect((err as LlmError).kind).toBe("unauthorized");
  });

  it("HTTP 200 但不是 SSE、也没有 error 体 → badResponse", async () => {
    const doFetch = () =>
      Promise.resolve(new Response("整段散文，不是流", { status: 200, headers: { "content-type": "text/plain" } }));
    const err = await run(createExternalEngine(CONFIG, doFetch as unknown as typeof fetch)).catch((e: unknown) => e);
    expect((err as LlmError).kind).toBe("badResponse");
  });

  it("fetch 抛出 → network", async () => {
    const doFetch = () => Promise.reject(new Error("ECONNREFUSED"));
    const err = await run(createExternalEngine(CONFIG, doFetch as unknown as typeof fetch)).catch((e: unknown) => e);
    expect((err as LlmError).kind).toBe("network");
  });

  it("配置不全时构造即拒绝", () => {
    expect(() => createExternalEngine({ ...CONFIG, apiKey: null }, fetch)).toThrow(LlmError);
  });
});
