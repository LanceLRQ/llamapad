import { afterEach, describe, expect, it, vi } from "vitest";
import { SSE_HEARTBEAT_MS, sseResponse } from "./sse";

/**
 * SSE 工具测试（M3 Task 1）
 *
 * 消费路径对齐真实使用：从返回的 Response.body 用 getReader 逐块读出，
 * 断言帧的字节内容（TextDecoder 还原）。心跳用 vi.useFakeTimers 推进 15s。
 * 每个用例结束时 cancel/close 流，避免心跳 interval 悬挂拖住测试进程。
 */

const decoder = new TextDecoder();

afterEach(() => {
  vi.useRealTimers();
});

describe("sseResponse：响应头", () => {
  it("Content-Type / Cache-Control / Connection / X-Accel-Buffering", async () => {
    const res = sseResponse(() => undefined);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(res.headers.get("connection")).toBe("keep-alive");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    await res.body!.cancel();
  });
});

describe("sseResponse：send 帧格式", () => {
  it("send(event) → `data: <JSON>\\n\\n`", async () => {
    const res = sseResponse((session) => {
      session.send({ hello: "世界", n: 1 });
    });
    const reader = res.body!.getReader();
    const { value, done } = await reader.read();
    expect(done).toBe(false);
    expect(decoder.decode(value)).toBe('data: {"hello":"世界","n":1}\n\n');
    await reader.cancel();
  });

  it("send(event, id) → `id: <id>\\ndata: <JSON>\\n\\n`（数字与字符串 id 各一帧）", async () => {
    const res = sseResponse((session) => {
      session.send({ n: 1 }, 42);
      session.send({ n: 2 }, "abc");
    });
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(decoder.decode(first.value)).toBe('id: 42\ndata: {"n":1}\n\n');
    const second = await reader.read();
    expect(decoder.decode(second.value)).toBe('id: abc\ndata: {"n":2}\n\n');
    await reader.cancel();
  });
});

describe("sseResponse：comment 帧与心跳", () => {
  it("comment(text) → `: <text>\\n\\n`", async () => {
    const res = sseResponse((session) => {
      session.comment("hello sse");
    });
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    expect(decoder.decode(value)).toBe(": hello sse\n\n");
    await reader.cancel();
  });

  it(`每 ${SSE_HEARTBEAT_MS}ms 自动 comment("ping")：15s 推进后读到 ": ping\\n\\n"`, async () => {
    vi.useFakeTimers();
    const res = sseResponse((session) => {
      session.send({ boot: true });
    });
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(decoder.decode(first.value)).toBe('data: {"boot":true}\n\n');

    const next = reader.read();
    vi.advanceTimersByTime(SSE_HEARTBEAT_MS);
    const ping = await next;
    expect(decoder.decode(ping.value)).toBe(": ping\n\n");
    await reader.cancel();
  });

  it("14.9s 无帧可读，越过 15s 整点后读到 ping（周期语义）", async () => {
    vi.useFakeTimers();
    const res = sseResponse(() => undefined);
    const reader = res.body!.getReader();

    vi.advanceTimersByTime(SSE_HEARTBEAT_MS - 100);
    let resolved = false;
    const pending = reader.read().then((r) => {
      resolved = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(0); // 冲刷微任务：14.9s 时仍不应有任何帧
    expect(resolved).toBe(false);

    vi.advanceTimersByTime(100); // 越过 15s 整点
    const ping = await pending;
    expect(resolved).toBe(true);
    expect(decoder.decode(ping.value)).toBe(": ping\n\n");
    await reader.cancel();
  });
});

describe("sseResponse：心跳清理（不留悬挂 interval）", () => {
  it("setup 内 controller.close()：清定时器、流终止、close 后 send 不再入队", async () => {
    vi.useFakeTimers();
    let session!: SseSessionLike;
    const res = sseResponse((s, controller) => {
      session = s as SseSessionLike;
      s.send({ bye: true });
      controller.close();
    });
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(decoder.decode(first.value)).toBe('data: {"bye":true}\n\n');
    const after = await reader.read();
    expect(after.done).toBe(true);

    vi.advanceTimersByTime(SSE_HEARTBEAT_MS * 2);
    expect(vi.getTimerCount()).toBe(0);
    expect(() => session.send({ late: true })).not.toThrow(); // closed 守卫，静默丢弃
  });

  it("客户端 cancel()（断开）：清定时器", async () => {
    vi.useFakeTimers();
    const res = sseResponse(() => undefined);
    const reader = res.body!.getReader();
    await reader.cancel();
    expect(vi.getTimerCount()).toBe(0);
  });
});

/** 测试内省用：拿到 session 引用以便 close 后再调 send */
type SseSessionLike = { send(event: unknown, id?: number | string): void };

