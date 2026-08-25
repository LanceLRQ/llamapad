import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHealthCollector, type FetchLike } from "./health";
import { METRIC_IDS } from "./ids";

/**
 * health 采集器测试（M3 Task 2，M4 真机订正）
 *
 * fetch 全部 mock（按 URL 后缀路由），覆盖：
 * - /health 仅作存活探测（真机 body 恒为 {"status":"ok"}，不解析 body）；
 *   连接失败 / 非 200 → 整轮放弃
 * - /slots 是 slot 信息的真实来源：is_processing 计数 → slots_running，
 *   n_prompt_tokens + next_token.n_decoded 求和 → kv_cache_tokens；
 *   非 200 / 非数组 / 坏 JSON / 连接失败都只静默跳过这两个指标，不牵连 /metrics
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

/** llama.cpp /metrics 文本（prometheus 计数器行 + HELP/TYPE 噪声行）。
 * 指标名为 M4 真机实测格式（llamacpp: 前缀，server-cuda 镜像 5f245844a324） */
function metricsText(prompt: number, predicted: number): Response {
  return textResponse(
    [
      "# HELP llamacpp:prompt_tokens_total Number of prompt tokens processed, excluding cached tokens",
      "# TYPE llamacpp:prompt_tokens_total counter",
      `llamacpp:prompt_tokens_total ${prompt}`,
      "# HELP llamacpp:tokens_predicted_total Number of generation tokens processed",
      "# TYPE llamacpp:tokens_predicted_total counter",
      `llamacpp:tokens_predicted_total ${predicted}`,
    ].join("\n"),
  );
}

/** 真机 /health 恒定形态：只有存活标记，无 slot 信息 */
const aliveHealth = () => jsonResponse({ status: "ok" });

/** 真机 /slots 空闲 slot 形态（M4 真机实测抓包） */
const idleSlot = { id: 0, n_ctx: 262144, speculative: false, is_processing: false };

/** 真机 /slots 处理中 slot 形态（M4 真机实测抓包，生成过程中抓取的完整顶层字段） */
const processingSlot = {
  id: 3,
  n_ctx: 262144,
  speculative: false,
  is_processing: true,
  id_task: 847,
  n_prompt_tokens: 334,
  n_prompt_tokens_processed: 4,
  n_prompt_tokens_cache: 14,
  params: { n_predict: -1 }, // 采样参数，与本测试无关
  next_token: [{ has_next_token: true, has_new_line: true, n_remain: 484, n_decoded: 316 }],
};

const running = async () => ({ hostPort: 18080 });
const stopped = async () => null;

describe("createHealthCollector：/health 存活探测", () => {
  it("[缺陷复现] 真机 body 仅 {status:ok}，无 slot 信息也不影响 /slots 正常产出", async () => {
    const collector = createHealthCollector(running, {
      fetch: routeFetch({
        "/health": aliveHealth,
        "/slots": () => jsonResponse([idleSlot, processingSlot]),
        "/metrics": () => textResponse("not found", 404),
      }),
    });

    const samples = await collector.tick();

    expect(samples).toEqual([
      { metric: METRIC_IDS.inferSlotsRunning, value: 1, ts: expect.any(Number) },
      { metric: METRIC_IDS.inferKvCacheTokens, value: 650, ts: expect.any(Number) },
    ]);
    expect(METRIC_IDS.inferSlotsRunning).toBe("infer.slots_running");
    expect(METRIC_IDS.inferKvCacheTokens).toBe("infer.kv_cache_tokens");
  });

  it("非 200 → 放弃整轮（即使 /slots、/metrics 会出数据也不产出）", async () => {
    const collector = createHealthCollector(running, {
      fetch: routeFetch({
        "/health": () => jsonResponse({ status: "ok" }, 500),
        "/slots": () => jsonResponse([processingSlot]),
        "/metrics": () => metricsText(100, 200),
      }),
    });
    expect(await collector.tick()).toEqual([]);
  });
});

describe("createHealthCollector：/slots 解析", () => {
  it("处理中 slot 的 kv 求和正确（n_prompt_tokens + next_token.n_decoded = 334+316=650）", async () => {
    const collector = createHealthCollector(running, {
      fetch: routeFetch({
        "/health": aliveHealth,
        "/slots": () => jsonResponse([idleSlot, processingSlot]),
        "/metrics": () => textResponse("", 404),
      }),
    });
    const samples = await collector.tick();
    expect(samples).toEqual([
      { metric: METRIC_IDS.inferSlotsRunning, value: 1, ts: expect.any(Number) },
      { metric: METRIC_IDS.inferKvCacheTokens, value: 650, ts: expect.any(Number) },
    ]);
  });

  it("多个处理中 slot 跨 slot 求和", async () => {
    const slotA = { id: 1, is_processing: true, n_prompt_tokens: 100, next_token: [{ n_decoded: 50 }] };
    const slotB = { id: 2, is_processing: true, n_prompt_tokens: 200, next_token: [{ n_decoded: 25 }] };
    const collector = createHealthCollector(running, {
      fetch: routeFetch({
        "/health": aliveHealth,
        "/slots": () => jsonResponse([slotA, slotB, idleSlot]),
        "/metrics": () => textResponse("", 404),
      }),
    });
    const samples = await collector.tick();
    expect(samples).toEqual([
      { metric: METRIC_IDS.inferSlotsRunning, value: 2, ts: expect.any(Number) },
      { metric: METRIC_IDS.inferKvCacheTokens, value: 375, ts: expect.any(Number) },
    ]);
  });

  it("全空闲 → slots_running=0、kv_cache_tokens=0 都照常产出（合法数组即产出，不因全 0 跳过）", async () => {
    const collector = createHealthCollector(running, {
      fetch: routeFetch({
        "/health": aliveHealth,
        "/slots": () => jsonResponse([idleSlot, { ...idleSlot, id: 1 }]),
        "/metrics": () => textResponse("", 404),
      }),
    });
    const samples = await collector.tick();
    expect(samples).toEqual([
      { metric: METRIC_IDS.inferSlotsRunning, value: 0, ts: expect.any(Number) },
      { metric: METRIC_IDS.inferKvCacheTokens, value: 0, ts: expect.any(Number) },
    ]);
  });

  it("next_token 为裸对象形态（非数组包装）也能算对", async () => {
    const slot = { id: 5, is_processing: true, n_prompt_tokens: 5, next_token: { n_decoded: 10 } };
    const collector = createHealthCollector(running, {
      fetch: routeFetch({
        "/health": aliveHealth,
        "/slots": () => jsonResponse([slot]),
        "/metrics": () => textResponse("", 404),
      }),
    });
    const samples = await collector.tick();
    expect(samples).toEqual([
      { metric: METRIC_IDS.inferSlotsRunning, value: 1, ts: expect.any(Number) },
      { metric: METRIC_IDS.inferKvCacheTokens, value: 15, ts: expect.any(Number) },
    ]);
  });

  it("字段缺失/非有限数按 0 计入该项，不影响其他 slot", async () => {
    const missingFields = { id: 6, is_processing: true }; // 无 n_prompt_tokens、无 next_token
    const badTypes = { id: 7, is_processing: true, n_prompt_tokens: "x", next_token: [{ n_decoded: "y" }] };
    const valid = { id: 8, is_processing: true, n_prompt_tokens: 40, next_token: [{ n_decoded: 10 }] };
    const collector = createHealthCollector(running, {
      fetch: routeFetch({
        "/health": aliveHealth,
        "/slots": () => jsonResponse([missingFields, badTypes, valid]),
        "/metrics": () => textResponse("", 404),
      }),
    });
    const samples = await collector.tick();
    expect(samples).toEqual([
      { metric: METRIC_IDS.inferSlotsRunning, value: 3, ts: expect.any(Number) },
      { metric: METRIC_IDS.inferKvCacheTokens, value: 50, ts: expect.any(Number) },
    ]);
  });

  it("非 200（如 --no-slots 场景下的 501）→ 两指标缺席，但 /metrics 的 tokens_per_sec 仍照常产出", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    try {
      let prompt = 100;
      let predicted = 200;
      const collector = createHealthCollector(running, {
        fetch: routeFetch({
          "/health": aliveHealth,
          "/slots": () => textResponse("Not Implemented", 501),
          "/metrics": () => metricsText(prompt, predicted),
        }),
      });

      const first = await collector.tick();
      expect(first).toEqual([]); // 首轮只建 /metrics 基线，/slots 501 无样本

      prompt = 160;
      predicted = 260;
      vi.setSystemTime(new Date("2026-01-01T00:00:05Z"));
      const second = await collector.tick();
      expect(second).toEqual([{ metric: METRIC_IDS.inferTokensPerSec, value: 24, ts: Date.now() }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("返回非数组（如对象）→ 静默跳过两个指标", async () => {
    const collector = createHealthCollector(running, {
      fetch: routeFetch({
        "/health": aliveHealth,
        "/slots": () => jsonResponse({ not: "an array" }),
        "/metrics": () => textResponse("", 404),
      }),
    });
    expect(await collector.tick()).toEqual([]);
  });

  it("返回坏 JSON → 静默跳过两个指标", async () => {
    const collector = createHealthCollector(running, {
      fetch: routeFetch({
        "/health": aliveHealth,
        "/slots": () => textResponse("not json at all"),
        "/metrics": () => textResponse("", 404),
      }),
    });
    expect(await collector.tick()).toEqual([]);
  });

  it("连接失败（fetch 抛错）→ 静默跳过两个指标，不中断整轮，/metrics 仍正常差分", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    try {
      let prompt = 100;
      let predicted = 200;
      const fetchImpl: FetchLike = (url) => {
        if (url.endsWith("/slots")) return Promise.reject(new TypeError("fetch failed"));
        if (url.endsWith("/health")) return Promise.resolve(aliveHealth());
        if (url.endsWith("/metrics")) return Promise.resolve(metricsText(prompt, predicted));
        return Promise.reject(new TypeError("fetch failed"));
      };
      const collector = createHealthCollector(running, { fetch: fetchImpl });

      const first = await collector.tick();
      expect(first).toEqual([]);

      prompt = 160;
      predicted = 260;
      vi.setSystemTime(new Date("2026-01-01T00:00:05Z"));
      const second = await collector.tick();
      expect(second).toEqual([{ metric: METRIC_IDS.inferTokensPerSec, value: 24, ts: Date.now() }]);
    } finally {
      vi.useRealTimers();
    }
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
        "/health": aliveHealth,
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
        "/health": aliveHealth,
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
        "/health": aliveHealth,
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
        "/health": aliveHealth,
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
