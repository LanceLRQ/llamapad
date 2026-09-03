import { describe, expect, it } from "vitest";

import { describeUnavailable, type LlmEngineState } from "./llm-availability";

function state(overrides: Partial<LlmEngineState>): LlmEngineState {
  return {
    engine: "external",
    externalReady: true,
    missing: [],
    hasRunningModel: true,
    ...overrides,
  };
}

describe("describeUnavailable", () => {
  it("状态还没取回时返回 null（未知，不是某一种不可用）", () => {
    expect(describeUnavailable(null)).toBeNull();
  });

  it("引擎整个没启用 —— disabled", () => {
    expect(describeUnavailable(state({ engine: "none" }))).toBe("disabled");
  });

  it("外部引擎但配置不全 —— incomplete", () => {
    expect(describeUnavailable(state({ engine: "external", externalReady: false, missing: ["apiKey"] })))
      .toBe("incomplete");
  });

  it("本地引擎但没有模型在跑 —— noModel", () => {
    expect(describeUnavailable(state({ engine: "local", hasRunningModel: false }))).toBe("noModel");
  });

  // 优先级：disabled 排最前——引擎选了「不用」时，外部/本地各自的配置状态
  // 已经不重要了，不该被 externalReady/hasRunningModel 的值干扰判定
  it("engine=none 时忽略 externalReady/hasRunningModel，仍判 disabled", () => {
    expect(describeUnavailable(state({ engine: "none", externalReady: false, hasRunningModel: false })))
      .toBe("disabled");
  });

  it("外部引擎配置齐全、本地字段不相关 —— 可用（null）", () => {
    expect(describeUnavailable(state({ engine: "external", externalReady: true }))).toBeNull();
  });

  it("本地引擎且有模型在跑 —— 可用（null）", () => {
    expect(describeUnavailable(state({ engine: "local", hasRunningModel: true }))).toBeNull();
  });
});
