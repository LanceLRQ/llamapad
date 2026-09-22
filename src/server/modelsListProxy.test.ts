import { describe, expect, it, vi } from "vitest";
import type { EffortMappingContext } from "./effortContext";
import { buildAggregatedModelsList, type FetchLike } from "./modelsListProxy";
import type { RunningModel } from "./runtime";

const running = (model: string, hostPort: number | null): RunningModel => ({
  model,
  container: `c-${model}`,
  startedAt: null,
  hostPort,
});

const upstream = (id: string) =>
  new Response(JSON.stringify({ object: "list", data: [{ id, object: "model", created: 1, owned_by: "llamacpp" }] }), {
    status: 200,
  });

// 显式接收（未使用的）model 参数：vi.fn(unknownContext) 按传入函数的实参个数推导
// mock.calls 的元组类型，零参函数会让下方 loadEffortContext.mock.calls 的
// ([model]) => model 解构在空元组上取下标 0，tsc 报 TS2493——与 ModelsListDeps
// 的签名对齐即可修正推导，行为不变（brief 原文是零参箭头函数，此处最小规避）
const unknownContext = async (_model: string): Promise<EffortMappingContext> => ({
  support: { state: "unknown", levels: null },
  config: { aliases: {}, rounding: "down" },
});

/** 按端口路由的 fetch mock；未配置的端口 ≈ 连接拒绝 */
function portFetch(routes: Record<number, () => Response>): FetchLike {
  return async (url) => {
    const port = Number(new URL(url).port);
    const route = routes[port];
    if (route === undefined) throw new TypeError("fetch failed");
    return route();
  };
}

describe("buildAggregatedModelsList", () => {
  it("默认模型排第一；id 为面板模型名；按各自模型取思考强度上下文并注入", async () => {
    const loadEffortContext = vi.fn(unknownContext);
    const body = await buildAggregatedModelsList([running("a", 18080), running("b", 18081)], "b", {
      fetch: portFetch({ 18080: () => upstream("/models/main/a.gguf"), 18081: () => upstream("b") }),
      loadEffortContext,
    });

    expect(body.object).toBe("list");
    expect(body.data.map((item) => item.id)).toEqual(["b", "a"]);
    expect(body.data[0]).toHaveProperty("x_llamapad");
    expect(loadEffortContext.mock.calls.map(([model]) => model).sort()).toEqual(["a", "b"]);
  });

  it("端口未知 / 上游非 200 / 连接失败 → 跳过该模型，不影响其他模型", async () => {
    const body = await buildAggregatedModelsList(
      [running("ghost", null), running("loading", 18081), running("down", 18082), running("ok", 18083)],
      "ok",
      {
        fetch: portFetch({ 18081: () => new Response("loading", { status: 503 }), 18083: () => upstream("ok") }),
        loadEffortContext: unknownContext,
      },
    );

    expect(body.data.map((item) => item.id)).toEqual(["ok"]);
  });

  it("没有运行中的模型 → 空列表，不发任何请求", async () => {
    const fetchSpy = vi.fn<FetchLike>();
    const body = await buildAggregatedModelsList([], null, { fetch: fetchSpy, loadEffortContext: unknownContext });

    expect(body).toEqual({ object: "list", data: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
