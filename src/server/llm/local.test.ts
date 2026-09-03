import { describe, expect, it, vi } from "vitest";

import { LlmError } from "./engine";
import { createLocalEngine } from "./local";

function sseResponse(lines: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(new TextEncoder().encode(`${line}\n`));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const RUNNING = { container: "llamapad-model", model: "qwen3-27b", hostPort: 18080 };

/** 造一帧带 content 的 SSE 数据行——空 content 流会被 streamCompletions 判为失败（见 engine.ts） */
const frame = (delta: Record<string, unknown>) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}`;

describe("createLocalEngine", () => {
  it("打到 llamaUpstreamBase(hostPort) + /v1/chat/completions", async () => {
    const doFetch = vi.fn(() =>
      Promise.resolve(sseResponse([frame({ content: "{}" }), "data: [DONE]"])),
    );
    const engine = createLocalEngine(RUNNING, null, doFetch as unknown as typeof fetch);
    await engine.run({ text: "片段", signal: new AbortController().signal, onDelta: vi.fn() });

    const [url] = doFetch.mock.calls[0] as unknown as [string];
    expect(url).toBe("http://127.0.0.1:18080/v1/chat/completions");
  });

  it("不带 authorization —— 面板的 token 不该泄漏给模型容器", async () => {
    const doFetch = vi.fn(() =>
      Promise.resolve(sseResponse([frame({ content: "{}" }), "data: [DONE]"])),
    );
    const engine = createLocalEngine(RUNNING, null, doFetch as unknown as typeof fetch);
    await engine.run({ text: "片段", signal: new AbortController().signal, onDelta: vi.fn() });

    const [, init] = doFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("model 取运行中模型名，落库与卡头都要显示它", () => {
    const engine = createLocalEngine(RUNNING, null, fetch);
    expect(engine.model).toBe("qwen3-27b");
  });

  it("没有模型在运行时构造即拒绝，kind = noRunningModel", () => {
    expect(() => createLocalEngine(null, null, fetch)).toThrow(LlmError);
    try {
      createLocalEngine(null, null, fetch);
    } catch (e) {
      expect((e as LlmError).kind).toBe("noRunningModel");
    }
  });

  it("容器在跑但配置行已删（hostPort 为 null）同样拒绝", () => {
    try {
      createLocalEngine({ ...RUNNING, hostPort: null }, null, fetch);
    } catch (e) {
      expect((e as LlmError).kind).toBe("noRunningModel");
    }
  });

  it("extraBody 同样透传（本地也可能是推理模型）", async () => {
    const doFetch = vi.fn(() =>
      Promise.resolve(sseResponse([frame({ content: "{}" }), "data: [DONE]"])),
    );
    const engine = createLocalEngine(RUNNING, { enable_thinking: false }, doFetch as unknown as typeof fetch);
    await engine.run({ text: "片段", signal: new AbortController().signal, onDelta: vi.fn() });

    const [, init] = doFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).enable_thinking).toBe(false);
  });
});
