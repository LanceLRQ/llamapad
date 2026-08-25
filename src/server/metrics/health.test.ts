import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHealthCollector, type FetchLike } from "./health";
import { METRIC_IDS } from "./ids";

/**
 * health 采集器测试（M3 Task 2，TDD）
 *
 * fetch 全部 mock（按 URL 后缀路由），覆盖：
 * - /health 200 完整 JSON → slots_running + kv_cache_tokens
 * - 字段缺失 / 类型不对 / JSON 坏 → 跳过不抛
 * - /health 500 → 无 health 样本
 * - /metrics 计数器两轮差分（第一轮建基线无 tokens 样本，第二轮有速率）
 * - 计数器回绕（值变小=重启）→ 重置基准不产出
 * - 连接拒绝 → 本轮无样本
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

/** 按路径后缀路由的 fetch mock；未匹配路径抛 TypeError（≈ 连接拒绝） */
function routeFetch(routes: Record<string, () => Response>): FetchLike {
  return (url) => {
    for (const [suffix, handler] of Object.entries(routes)) {
      if (url.endsWith(suffix)) return Promise.resolve(handler());
    }
    return Promise.reject(new TypeError("fetch failed"));
  };
}

/** llama.cpp /metrics 文本（prometheus 计数器行 + HELP/TYPE 噪声行） */
function metricsText(prompt: number, predicted: number): Response {
  return textResponse(
    [
      "# HELP llama_prompt_tokens_total Number of prompt tokens.",
      "# TYPE llama_prompt_tokens_total counter",
      `llama_prompt_tokens_total ${prompt}`,
      "# HELP llama_tokens_predicted_total Number of generated tokens.",
      "# TYPE llama_tokens_predicted_total counter",
      `llama_tokens_predicted_total ${predicted}`,
    ].join("\n"),
  );
}

const running = async () => ({ hostPort: 18080 });
const stopped = async () => null;

describe("createHealthCollector：/health 宽容解析", () => {
  it("完整 JSON → infer.slots_running + slots[].cache_tokens 求和 infer.kv_cache_tokens", async () => {
    const fetchMock = vi.fn(
      routeFetch({
        "/health": () => jsonResponse({ slots_running: 2, slots: [{ cache_tokens: 120 }, { cache_tokens: 80 }] }),
        "/metrics": () => textResponse("not found", 404),
      }),
    );
    const collector = createHealthCollector(running, { fetch: fetchMock });

    const samples = await collector.tick();

    expect(samples).toEqual([
      { metric: METRIC_IDS.inferSlotsRunning, value: 2, ts: expect.any(Number) },
      { metric: METRIC_IDS.inferKvCacheTokens, value: 200, ts: expect.any(Number) },
    ]);
    expect(METRIC_IDS.inferSlotsRunning).toBe("infer.slots_running");
    expect(METRIC_IDS.inferKvCacheTokens).toBe("infer.kv_cache_tokens");
    expect(METRIC_IDS.inferTokensPerSec).toBe("infer.tokens_per_sec");
  });

  it("字段缺失或类型不对（空对象 / slots_running 字符串 / slots 非数组 / 坏 JSON）→ 跳过不抛，无样本", async () => {
    for (const body of [
      jsonResponse({}),
      jsonResponse({ slots_running: "2", slots: "no" }),
      jsonResponse({ slots: [{ no_cache: 1 }] }),
      textResponse("not json at all"),
    ]) {
      const collector = createHealthCollector(running, {
        fetch: routeFetch({ "/health": () => body, "/metrics": () => textResponse("", 404) }),
      });
      expect(await collector.tick()).toEqual([]);
    }
  });

  it("slots 内 cache_tokens 混入非数值 → 只累加数值项", async () => {
    const collector = createHealthCollector(running, {
      fetch: routeFetch({
        "/health": () => jsonResponse({ slots: [{ cache_tokens: 30 }, { cache_tokens: "x" }, {}, { cache_tokens: 5 }] }),
        "/metrics": () => textResponse("", 404),
      }),
    });
    const samples = await collector.tick();
    expect(samples).toEqual([
      { metric: METRIC_IDS.inferKvCacheTokens, value: 35, ts: expect.any(Number) },
    ]);
  });

  it("/health 500 → 无 health 样本（不抛）", async () => {
    const collector = createHealthCollector(running, {
      fetch: routeFetch({ "/health": () => jsonResponse({ slots_running: 1 }, 500), "/metrics": () => textResponse("", 404) }),
    });
    expect(await collector.tick()).toEqual([]);
  });
});

describe("createHealthCollector：/metrics 计数器差分", () => {
  beforeEach(() => {
    // 只伪造 Date：差分需要可控时间，AbortSignal.timeout 等 timer 保持真实（fetch 是 mock）
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("两轮差分：第一轮建基线无 tokens 样本；第二轮 Δ/秒 → infer.tokens_per_sec", async () => {
    let prompt = 100;
    let predicted = 200;
    const collector = createHealthCollector(running, {
      fetch: routeFetch({
        "/health": () => jsonResponse({}),
        "/metrics": () => metricsText(prompt, predicted),
      }),
    });

    const first = await collector.tick();
    expect(first.filter((s) => s.metric === METRIC_IDS.inferTokensPerSec)).toEqual([]);

    prompt = 160; // Δprompt = 60
    predicted = 260; // Δpredicted = 60
    vi.setSystemTime(new Date("2026-01-01T00:00:05Z")); // Δt = 5s → (60+60)/5 = 24
    const second = await collector.tick();
    expect(second).toEqual([
      { metric: METRIC_IDS.inferTokensPerSec, value: 24, ts: Date.now() },
    ]);
  });

  it("计数器回绕（重启后值变小）→ 重置基准不产出；随后正常差分恢复", async () => {
    let prompt = 500;
    let predicted = 500;
    const collector = createHealthCollector(running, {
      fetch: routeFetch({
        "/health": () => jsonResponse({}),
        "/metrics": () => metricsText(prompt, predicted),
      }),
    });

    await collector.tick(); // 基线 500/500

    prompt = 10; // 重启：计数器清零变小
    predicted = 10;
    const afterRestart = await collector.tick();
    expect(afterRestart.filter((s) => s.metric === METRIC_IDS.inferTokensPerSec)).toEqual([]);

    prompt = 110; // 基于新基准差分：(100+100)/5 = 40
    predicted = 110;
    vi.setSystemTime(new Date("2026-01-01T00:00:05Z"));
    const resumed = await collector.tick();
    expect(resumed).toEqual([
      { metric: METRIC_IDS.inferTokensPerSec, value: 40, ts: Date.now() },
    ]);
  });

  it("Δ=0（无推理流量）→ 不产出 tokens 样本", async () => {
    const collector = createHealthCollector(running, {
      fetch: routeFetch({
        "/health": () => jsonResponse({}),
        "/metrics": () => metricsText(100, 100),
      }),
    });
    await collector.tick();
    vi.setSystemTime(new Date("2026-01-01T00:00:05Z"));
    expect(await collector.tick()).toEqual([]);
  });

  it("/metrics 文本缺计数器行 → 静默跳过（不更新基线）", async () => {
    const collector = createHealthCollector(running, {
      fetch: routeFetch({
        "/health": () => jsonResponse({}),
        "/metrics": () => textResponse("# only help lines\nllama_other_metric 1\n"),
      }),
    });
    expect(await collector.tick()).toEqual([]);
  });
});

describe("createHealthCollector：降级路径", () => {
  it("连接拒绝（fetch 抛错）→ 本轮无样本，不抛", async () => {
    const collector = createHealthCollector(running, {
      fetch: () => Promise.reject(new TypeError("fetch failed")),
    });
    await expect(collector.tick()).resolves.toEqual([]);
  });

  it("无运行模型（getTarget → null）→ 不发起任何请求", async () => {
    const fetchMock = vi.fn();
    const collector = createHealthCollector(stopped, { fetch: fetchMock });
    await expect(collector.tick()).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
