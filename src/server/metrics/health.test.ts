import { describe, expect, it, vi } from "vitest";
import { createHealthCollector, type FetchLike } from "./health";
import { METRIC_IDS } from "./ids";

/**
 * health 采集器测试（M3 Task 2，M4 真机订正，M5 生成速率口径订正）
 *
 * fetch 全部 mock（按 URL 后缀路由），覆盖：
 * - /health 仅作存活探测（真机 body 恒为 {"status":"ok"}，不解析 body）；
 *   连接失败 / 非 200 → 整轮放弃
 * - /slots 是 slot 信息的真实来源：is_processing 计数 → slots_running，
 *   n_prompt_tokens + next_token.n_decoded 求和 → kv_cache_tokens；同一 slot
 *   （同 id 且同 id_task）跨 tick 的 n_decoded 差分 → tokens_per_sec（真·生成
 *   速率，不含 prompt eval）；id_task 变化（换请求）只重建基线不产出；slot
 *   转 idle（next_token 缺席）不产出负值；非 200 / 非数组 / 坏 JSON / 连接
 *   失败都只静默跳过这三个指标，不牵连 /metrics
 * - /metrics 仍请求（存活的另一重信号），但计数器差分口径已废弃，不再产出
 *   tokens_per_sec（该计数器结算滞后 + 口径含 prompt eval，详见 health.ts）
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

/** 真机 /health 恒定形态：只有存活标记，无 slot 信息 */
const aliveHealth = () => jsonResponse({ status: "ok" });

/**
 * 路由的响应来源：Response 对象、任意可 JSON 序列化的裸值，或返回三者之一的
 * thunk（闭包捕获可变状态，每次路由命中都重新求值——跨 tick 变化的用例要用
 * 这个）。thunk 也可以返回一个 rejected Promise，模拟该端点连接失败——与真实
 * fetch() 的失败形态一致（拒绝而非同步抛错），routeFetch 会原样透传该拒绝。
 */
type RouteEntry = Response | unknown[] | Record<string, unknown> | string | (() => Response | Promise<Response> | unknown);

/** 未显式覆盖 /health、/metrics 时的默认响应：多数用例只关心 /slots，
 * 不必逐个补齐存活探测与计数器端点 */
const defaultRoutes: Record<string, RouteEntry> = {
  "/health": aliveHealth,
  "/metrics": () => textResponse("", 404),
};

/** 按路径后缀路由的 fetch mock；未匹配路径抛 TypeError（≈ 连接拒绝）。
 * 路由值可以是 Response、裸值（自动包一层 JSON 响应）、返回二者之一的 thunk，
 * 或返回 rejected Promise 的 thunk（模拟该端点连接失败，原样透传） */
function routeFetch(routes: Record<string, RouteEntry>): FetchLike {
  const merged: Record<string, RouteEntry> = { ...defaultRoutes, ...routes };
  return (url) => {
    for (const [suffix, entry] of Object.entries(merged)) {
      if (!url.endsWith(suffix)) continue;
      const result = typeof entry === "function" ? entry() : entry;
      if (result instanceof Promise) return result as Promise<Response>;
      return Promise.resolve(result instanceof Response ? result : jsonResponse(result));
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

  it("非 200（如 --no-slots 场景下的 501）→ 三个指标全部缺席（生成速率现在也来自 /slots，非 /metrics）", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    try {
      const collector = createHealthCollector(running, {
        fetch: routeFetch({
          "/slots": () => textResponse("Not Implemented", 501),
        }),
      });

      expect(await collector.tick()).toEqual([]);
      vi.setSystemTime(new Date("2026-01-01T00:00:05Z"));
      expect(await collector.tick()).toEqual([]);
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

  it("连接失败（fetch 抛错）→ 静默跳过全部三个指标，不中断整轮", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    try {
      const fetchImpl: FetchLike = (url) => {
        if (url.endsWith("/slots")) return Promise.reject(new TypeError("fetch failed"));
        if (url.endsWith("/health")) return Promise.resolve(aliveHealth());
        if (url.endsWith("/metrics")) return Promise.resolve(textResponse("", 404));
        return Promise.reject(new TypeError("fetch failed"));
      };
      const collector = createHealthCollector(running, { fetch: fetchImpl });

      expect(await collector.tick()).toEqual([]);
      vi.setSystemTime(new Date("2026-01-01T00:00:05Z"));
      expect(await collector.tick()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("同一 slot 跨两 tick：按 n_decoded 差分算生成速率（真·生成口径，不含 prompt）", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const slot = (nDecoded: number) => ({
        id: 0, n_ctx: 4096, speculative: false, is_processing: true,
        id_task: 7, n_prompt_tokens: 334, next_token: [{ n_decoded: nDecoded }],
      });
      let decoded = 100;
      const collector = createHealthCollector(async () => ({ hostPort: 8080 }), {
        fetch: routeFetch({ slots: () => [slot(decoded)] }),
      });

      expect((await collector.tick()).find((s) => s.metric === METRIC_IDS.inferTokensPerSec)).toBeUndefined();

      vi.advanceTimersByTime(5_000);
      decoded = 250; // 5 秒生成 150 token → 30 tok/s
      const second = await collector.tick();
      const tps = second.find((s) => s.metric === METRIC_IDS.inferTokensPerSec);
      expect(tps?.value).toBeCloseTo(30, 5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("id_task 变化（换了新请求）→ 只重建基线不产出，避免跨请求穿帮", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      let task = 7, decoded = 500;
      const collector = createHealthCollector(async () => ({ hostPort: 8080 }), {
        fetch: routeFetch({ slots: () => [{
          id: 0, n_ctx: 4096, speculative: false, is_processing: true,
          id_task: task, n_prompt_tokens: 10, next_token: [{ n_decoded: decoded }],
        }] }),
      });
      await collector.tick();
      vi.advanceTimersByTime(5_000);
      task = 8; decoded = 20; // 新请求，n_decoded 回落
      const out = await collector.tick();
      expect(out.find((s) => s.metric === METRIC_IDS.inferTokensPerSec)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("slot 转 idle（next_token 缺席）→ 不产出样本（缺席不等于 0，不会算出负值）", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      let processing = true;
      const collector = createHealthCollector(async () => ({ hostPort: 8080 }), {
        fetch: routeFetch({ slots: () => [processing
          ? { id: 0, n_ctx: 4096, speculative: false, is_processing: true, id_task: 7, n_prompt_tokens: 10, next_token: [{ n_decoded: 300 }] }
          : { id: 0, n_ctx: 4096, speculative: false, is_processing: false }] }),
      });
      await collector.tick();
      vi.advanceTimersByTime(5_000);
      processing = false;
      const out = await collector.tick();
      expect(out.find((s) => s.metric === METRIC_IDS.inferTokensPerSec)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createHealthCollector：/metrics 端点（计数器差分口径已废弃）", () => {
  it("/metrics 计数器变化不再产出 infer.tokens_per_sec（口径已改为 /slots 的 n_decoded 差分，见上）", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    try {
      let prompt = 100;
      let predicted = 200;
      const collector = createHealthCollector(running, {
        fetch: routeFetch({
          "/metrics": () => metricsText(prompt, predicted),
        }),
      });

      await collector.tick();
      prompt = 160; // Δprompt = 60
      predicted = 260; // Δpredicted = 60，走老口径会算出 (60+60)/5=24，新口径不应产出
      vi.setSystemTime(new Date("2026-01-01T00:00:05Z"));
      const second = await collector.tick();
      expect(second.find((s) => s.metric === METRIC_IDS.inferTokensPerSec)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("连接失败（fetch 抛错）→ 静默跳过，不牵连本轮已产出的 /slots 样本", async () => {
    const collector = createHealthCollector(running, {
      fetch: routeFetch({
        "/slots": () => jsonResponse([processingSlot]),
        "/metrics": () => Promise.reject(new TypeError("fetch failed")),
      }),
    });
    const samples = await collector.tick();
    expect(samples).toEqual([
      { metric: METRIC_IDS.inferSlotsRunning, value: 1, ts: expect.any(Number) },
      { metric: METRIC_IDS.inferKvCacheTokens, value: 650, ts: expect.any(Number) },
    ]);
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
