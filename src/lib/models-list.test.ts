import { describe, expect, it } from "vitest";
import { mergeModelLists, orderForModelsList } from "./models-list";

const upstream = (id: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    models: [{ name: id }],
    object: "list",
    data: [{ id, object: "model", created: 1, owned_by: "llamacpp", meta: { n_ctx_train: 4096 }, ...extra }],
  });

describe("mergeModelLists", () => {
  it("逐个取 data 第一项，id 改写为面板模型名，其余字段原样保留；顶层只保留 object 与 data", () => {
    const body = mergeModelLists([
      { model: "a", body: upstream("a", { supported_parameters: ["reasoning_effort"] }) },
      { model: "b", body: upstream("/models/main/b.gguf") },
    ]);
    expect(body).toEqual({
      object: "list",
      data: [
        {
          id: "a",
          object: "model",
          created: 1,
          owned_by: "llamacpp",
          meta: { n_ctx_train: 4096 },
          supported_parameters: ["reasoning_effort"],
        },
        { id: "b", object: "model", created: 1, owned_by: "llamacpp", meta: { n_ctx_train: 4096 } },
      ],
    });
  });

  it("body 为 null（未就绪/请求失败）、JSON 解不开、data 不是数组或为空 → 跳过该模型", () => {
    const body = mergeModelLists([
      { model: "loading", body: null },
      { model: "bad", body: "<html>" },
      { model: "odd", body: JSON.stringify({ data: {} }) },
      { model: "empty", body: JSON.stringify({ data: [] }) },
      { model: "ok", body: upstream("ok") },
    ]);
    expect(body.data.map((item) => item.id)).toEqual(["ok"]);
  });

  it("全部跳过 → 空列表（仍是合法的标准响应）", () => {
    expect(mergeModelLists([])).toEqual({ object: "list", data: [] });
  });
});

describe("orderForModelsList", () => {
  it("默认模型排第一，其余保持原顺序", () => {
    const models = [{ model: "a" }, { model: "b" }, { model: "c" }];
    expect(orderForModelsList(models, "b").map((m) => m.model)).toEqual(["b", "a", "c"]);
  });

  it("默认模型为 null 或不在列表中 → 原顺序", () => {
    const models = [{ model: "a" }, { model: "b" }];
    expect(orderForModelsList(models, null).map((m) => m.model)).toEqual(["a", "b"]);
    expect(orderForModelsList(models, "x").map((m) => m.model)).toEqual(["a", "b"]);
  });
});
