import { describe, expect, it, vi } from "vitest";
import { probeBusy, waitForIdle } from "./drain";
import type { FetchLike } from "./metrics/health";

/**
 * 排空（drain）逻辑测试（切换模型前等在途推理结束）
 *
 * 覆盖 waitForIdle 的核心取舍：/slots 探测不到（连接失败/非 200/非数组/坏 JSON）
 * 一律立即放行（reason: "unavailable"），绝不重试等待；首次探测即空闲不先睡一轮；
 * 持续忙碌到 timeoutMs 才判超时。fetch/now/sleep 全部注入，不碰真实网络/定时器。
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status });
}

const processingSlot = { id: 0, is_processing: true };
const idleSlot = { id: 0, is_processing: false };

describe("waitForIdle", () => {
  it("首次探测即空闲 → 立即返回 idle，不先睡一轮再探", async () => {
    const fetchMock: FetchLike = vi.fn(async () => jsonResponse([idleSlot]));
    const sleepMock = vi.fn(async () => {});

    const result = await waitForIdle({
      hostPort: 18080,
      timeoutMs: 5_000,
      fetch: fetchMock,
      sleep: sleepMock,
    });

    expect(result).toEqual({ drained: true, reason: "idle" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleepMock).not.toHaveBeenCalled();
  });

  it("忙 2 轮后转空闲 → drained:true reason:idle，轮询次数与 sleep 次数匹配", async () => {
    let call = 0;
    const fetchMock: FetchLike = vi.fn(async () => {
      call += 1;
      return jsonResponse(call <= 2 ? [processingSlot] : [idleSlot]);
    });
    const sleepMock = vi.fn(async () => {});

    const result = await waitForIdle({
      hostPort: 18080,
      timeoutMs: 5_000,
      fetch: fetchMock,
      sleep: sleepMock,
      now: () => 0, // 恒定时钟，避免超时判定提前介入
    });

    expect(result).toEqual({ drained: true, reason: "idle" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleepMock).toHaveBeenCalledTimes(2);
  });

  it("持续忙碌超过 timeoutMs → drained:false reason:timeout（调用方照停不误）", async () => {
    const fetchMock: FetchLike = vi.fn(async () => jsonResponse([processingSlot]));
    let now = 0;
    const sleepMock = vi.fn(async (ms: number) => {
      now += ms;
    });

    const result = await waitForIdle({
      hostPort: 18080,
      timeoutMs: 1_000,
      pollMs: 500,
      fetch: fetchMock,
      sleep: sleepMock,
      now: () => now,
    });

    expect(result).toEqual({ drained: false, reason: "timeout" });
  });

  it("/slots 非 200 → 立即放行 unavailable，不重试等待", async () => {
    const fetchMock: FetchLike = vi.fn(async () => textResponse("boom", 500));

    const result = await waitForIdle({ hostPort: 18080, timeoutMs: 5_000, fetch: fetchMock });

    expect(result).toEqual({ drained: true, reason: "unavailable" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("连接失败（fetch 抛错）→ 立即放行 unavailable", async () => {
    const fetchMock: FetchLike = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });

    const result = await waitForIdle({ hostPort: 18080, timeoutMs: 5_000, fetch: fetchMock });

    expect(result).toEqual({ drained: true, reason: "unavailable" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("body 非数组 → 立即放行 unavailable", async () => {
    const fetchMock: FetchLike = vi.fn(async () => jsonResponse({ not: "an array" }));

    const result = await waitForIdle({ hostPort: 18080, timeoutMs: 5_000, fetch: fetchMock });

    expect(result).toEqual({ drained: true, reason: "unavailable" });
  });

  it("JSON 坏 → 立即放行 unavailable", async () => {
    const fetchMock: FetchLike = vi.fn(async () => textResponse("not json at all"));

    const result = await waitForIdle({ hostPort: 18080, timeoutMs: 5_000, fetch: fetchMock });

    expect(result).toEqual({ drained: true, reason: "unavailable" });
  });

  it("pollMs 生效：轮询间隔按传入值调用 sleep", async () => {
    let call = 0;
    const fetchMock: FetchLike = vi.fn(async () => {
      call += 1;
      return jsonResponse(call === 1 ? [processingSlot] : [idleSlot]);
    });
    const sleepCalls: number[] = [];
    const sleepMock = vi.fn(async (ms: number) => {
      sleepCalls.push(ms);
    });

    await waitForIdle({
      hostPort: 18080,
      timeoutMs: 5_000,
      pollMs: 111,
      fetch: fetchMock,
      sleep: sleepMock,
      now: () => 0,
    });

    expect(sleepCalls).toEqual([111]);
  });
});

describe("probeBusy", () => {
  it("正常且有处理中 slot → inferring:true", async () => {
    const fetchMock: FetchLike = vi.fn(async () => jsonResponse([processingSlot, idleSlot]));

    await expect(probeBusy(18080, { fetch: fetchMock })).resolves.toEqual({
      inferring: true,
      slotsRunning: 1,
    });
  });

  it("正常但全部空闲 → inferring:false slotsRunning:0", async () => {
    const fetchMock: FetchLike = vi.fn(async () => jsonResponse([idleSlot]));

    await expect(probeBusy(18080, { fetch: fetchMock })).resolves.toEqual({
      inferring: false,
      slotsRunning: 0,
    });
  });

  it("非 200 → null（不可知，不是不忙）", async () => {
    const fetchMock: FetchLike = vi.fn(async () => textResponse("boom", 500));

    await expect(probeBusy(18080, { fetch: fetchMock })).resolves.toBeNull();
  });

  it("连接失败 → null", async () => {
    const fetchMock: FetchLike = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });

    await expect(probeBusy(18080, { fetch: fetchMock })).resolves.toBeNull();
  });

  it("body 非数组 → null", async () => {
    const fetchMock: FetchLike = vi.fn(async () => jsonResponse({ not: "an array" }));

    await expect(probeBusy(18080, { fetch: fetchMock })).resolves.toBeNull();
  });
});
