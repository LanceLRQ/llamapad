import { describe, expect, it } from "vitest";
import { buildLlmTargets, llmTargetId, resolveLlmTarget, type LlmTargetInput } from "./llm-targets";

describe("buildLlmTargets", () => {
  it("外部配齐 + 两个本地 → 三项，顺序外部在前、本地按传入顺序在后", () => {
    const input: LlmTargetInput = {
      externalReady: true,
      externalModel: "gpt-4o",
      runningModels: ["A", "B"],
    };
    expect(buildLlmTargets(input).map(llmTargetId)).toEqual(["external", "local:A", "local:B"]);
  });

  it("外部未配齐 + 一个本地 → 只有本地那项", () => {
    const input: LlmTargetInput = {
      externalReady: false,
      externalModel: "gpt-4o",
      runningModels: ["A"],
    };
    expect(buildLlmTargets(input)).toEqual([{ kind: "local", model: "A" }]);
  });

  it("externalReady:true 但 externalModel:null → 不产出 external 项", () => {
    const input: LlmTargetInput = { externalReady: true, externalModel: null, runningModels: [] };
    expect(buildLlmTargets(input)).toEqual([]);
  });

  it('externalReady:true 但 externalModel:"   " → 不产出 external 项', () => {
    const input: LlmTargetInput = { externalReady: true, externalModel: "   ", runningModels: [] };
    expect(buildLlmTargets(input)).toEqual([]);
  });

  it('runningModels:["A","","  ","B"] → 只保留 A、B', () => {
    const input: LlmTargetInput = {
      externalReady: false,
      externalModel: null,
      runningModels: ["A", "", "  ", "B"],
    };
    expect(buildLlmTargets(input)).toEqual([
      { kind: "local", model: "A" },
      { kind: "local", model: "B" },
    ]);
  });

  it('runningModels:["A","B","A"] → 去重成 A、B，且 A 仍在 B 前', () => {
    const input: LlmTargetInput = {
      externalReady: false,
      externalModel: null,
      runningModels: ["A", "B", "A"],
    };
    expect(buildLlmTargets(input)).toEqual([
      { kind: "local", model: "A" },
      { kind: "local", model: "B" },
    ]);
  });

  it("两边都空 → []", () => {
    const input: LlmTargetInput = { externalReady: false, externalModel: null, runningModels: [] };
    expect(buildLlmTargets(input)).toEqual([]);
  });
});

describe("llmTargetId", () => {
  it("external → \"external\"", () => {
    expect(llmTargetId({ kind: "external", model: "gpt-4o" })).toBe("external");
  });

  it("local → `local:${model}`，模型名原样不转义", () => {
    expect(llmTargetId({ kind: "local", model: "Qwen/Qwen3-8B" })).toBe("local:Qwen/Qwen3-8B");
  });
});

describe("resolveLlmTarget", () => {
  const input: LlmTargetInput = {
    externalReady: true,
    externalModel: "gpt-4o",
    runningModels: ["A", "B"],
  };

  it("命中 external", () => {
    expect(resolveLlmTarget(input, "external")).toEqual({ kind: "external", model: "gpt-4o" });
  });

  it("命中 local", () => {
    expect(resolveLlmTarget(input, "local:A")).toEqual({ kind: "local", model: "A" });
  });

  it("id 指向一个没在运行的模型 → null", () => {
    expect(resolveLlmTarget(input, "local:不存在")).toBeNull();
  });

  it("空候选集下任何 id 都返回 null", () => {
    const empty: LlmTargetInput = { externalReady: false, externalModel: null, runningModels: [] };
    expect(resolveLlmTarget(empty, "external")).toBeNull();
    expect(resolveLlmTarget(empty, "local:A")).toBeNull();
  });

  it.each(["local:", "LOCAL:A", ""])("畸形 id %j → null", (id) => {
    expect(resolveLlmTarget(input, id)).toBeNull();
  });
});
