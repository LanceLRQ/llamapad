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
    const doFetch = vi.fn(() =>
      Promise.resolve(sseResponse([frame({ content: "{}" }), "data: [DONE]"])),
    );
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
    const doFetch = vi.fn(() =>
      Promise.resolve(sseResponse([frame({ content: "{}" }), "data: [DONE]"])),
    );
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
    const doFetch = vi.fn(() =>
      Promise.resolve(sseResponse([frame({ content: "{}" }), "data: [DONE]"])),
    );
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

  // 流正常结束却一个字都没有：这是失败，不是"模型认为 README 里没参数"——
  // 后者按 prompt 契约会给 {"profiles":[]}。返回空串会被下游当成后者，
  // 等于把服务端故障说成"没找到"
  it("流正常结束但没有任何 content，抛 badResponse", async () => {
    // 200 + event-stream，只发 data: [DONE]
    const doFetch = () => Promise.resolve(sseResponse(["data: [DONE]"]));
    await expect(
      run(createExternalEngine(CONFIG, doFetch as unknown as typeof fetch)),
    ).rejects.toMatchObject({ kind: "badResponse" });
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

describe("createExternalEngine 流内错误帧不再被吞掉", () => {
  // 锁的是发现①：streamCompletions 的 LineSplitter 回调此前只认 reasoning/content，
  // parseSseLine 产出的 error 事件被 if/else 静默丢弃，最终 return content 会把
  // "服务商中途报错"伪装成"成功但空"。现在流内 error 帧要在读流结束后统一分类抛出，
  // 断言必须是"确实抛了"而不是断言返回值——后者在行为改回去时照样能过
  it("流中途 error 帧命中限流关键词 → 抛 rateLimited", async () => {
    const doFetch = () =>
      Promise.resolve(
        sseResponse([
          frame({ content: "部分正文" }),
          `data: ${JSON.stringify({ error: { message: "访问量过大，请稍后再试" } })}`,
        ]),
      );

    await expect(
      run(createExternalEngine(CONFIG, doFetch as unknown as typeof fetch)),
    ).rejects.toMatchObject({ kind: "rateLimited" });
  });

  // 锁的是：错误信息不含限流特征时落到 badResponse，不能笼统当成限流——
  // 会让"该充值"的用户误以为"该重试"
  it("流中途 error 帧不含限流关键词 → 抛 badResponse", async () => {
    const doFetch = () =>
      Promise.resolve(
        sseResponse([
          frame({ content: "部分正文" }),
          `data: ${JSON.stringify({ error: { message: "内容被安全策略拦截" } })}`,
        ]),
      );

    const err = await run(createExternalEngine(CONFIG, doFetch as unknown as typeof fetch)).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).kind).toBe("badResponse");
  });
});

describe("createExternalEngine 读流阶段的传输异常", () => {
  // 锁的是发现②：读流循环此前没有 try/catch，reader.read() 抛错会以裸异常
  // 逃出 run()，下游按 instanceof LlmError 取 kind 的写法会直接落进兜底分支
  it("reader.read() 中途抛错 → 抛 LlmError 且 kind 是 network", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`${frame({ content: "部分" })}\n`));
        controller.error(new Error("stream reset"));
      },
    });
    const doFetch = () =>
      Promise.resolve(
        new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
      );

    const err = await run(createExternalEngine(CONFIG, doFetch as unknown as typeof fetch)).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).kind).toBe("network");
  });

  // 锁的是发现②的另一半：请求已发出、进入读流阶段才 abort，要落到
  // network + "已取消"，不能是未分类的 AbortError 裸奔出去
  it("请求发出后才 abort（读流阶段中断）→ 抛 network 且消息是已取消", async () => {
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller.signal.addEventListener("abort", () => {
          streamController.error(new DOMException("Aborted", "AbortError"));
        });
      },
    });
    const doFetch = () =>
      Promise.resolve(
        new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
      );

    const enginePromise = createExternalEngine(CONFIG, doFetch as unknown as typeof fetch).run({
      text: "README 片段",
      signal: controller.signal,
      onDelta: vi.fn(),
    });
    controller.abort();

    const err = await enginePromise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).kind).toBe("network");
    expect((err as LlmError).message).toBe("已取消");
  });
});
