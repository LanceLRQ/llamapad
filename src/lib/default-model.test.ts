import { describe, expect, it } from "vitest";
import { resolveDefaultModel, sortByStartedAt } from "./default-model";

const at = (iso: string | null, container: string, model = container) => ({ model, container, startedAt: iso });

describe("sortByStartedAt", () => {
  it("按启动时间升序；不修改入参", () => {
    const input = [at("2026-09-16T10:00:02.000Z", "b"), at("2026-09-16T10:00:01.000Z", "a")];
    const sorted = sortByStartedAt(input);
    expect(sorted.map((x) => x.container)).toEqual(["a", "b"]);
    expect(input.map((x) => x.container)).toEqual(["b", "a"]);
  });

  it("启动时间相同（dockerode 的 Created 只到秒）→ 按容器名排，结果稳定", () => {
    const t = "2026-09-16T10:00:00.000Z";
    expect(sortByStartedAt([at(t, "llama-server-b"), at(t, "llama-server")]).map((x) => x.container)).toEqual([
      "llama-server",
      "llama-server-b",
    ]);
  });

  it("startedAt 为 null 的排在最后", () => {
    const sorted = sortByStartedAt([at(null, "x"), at("2026-09-16T10:00:00.000Z", "y")]);
    expect(sorted.map((x) => x.container)).toEqual(["y", "x"]);
  });
});

describe("resolveDefaultModel", () => {
  const running = [{ model: "a" }, { model: "b" }];

  it("当前默认仍在运行 → 保持不变", () => {
    expect(resolveDefaultModel("b", running)).toBe("b");
  });

  it("当前默认为空 → 取第一个（调用方传入的列表已按启动时间升序）", () => {
    expect(resolveDefaultModel(null, running)).toBe("a");
  });

  it("当前默认已不在运行 → 换成第一个", () => {
    expect(resolveDefaultModel("gone", running)).toBe("a");
  });

  it("没有模型在运行 → null", () => {
    expect(resolveDefaultModel("a", [])).toBeNull();
    expect(resolveDefaultModel(null, [])).toBeNull();
  });
});
