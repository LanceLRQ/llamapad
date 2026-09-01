import { describe, expect, it } from "vitest";
import type { EffortSupport } from "./reasoning-effort";
import { resolveEffort, type EffortMappingConfig } from "./effort-mapping";

/**
 * Qwen3.8 系真实值域（与 reasoning-effort.test.ts 的 QWEN3_8_UD_TEMPLATE 一致）：
 * 模板只认 xhigh/medium/low，客户端常发的 high/max/minimal 都不在其中。
 */
const QWEN3_8_SUPPORT: EffortSupport = {
  state: "supported",
  levels: ["xhigh", "medium", "low"],
};

const UNKNOWN_SUPPORT: EffortSupport = { state: "unknown", levels: null };
const UNSUPPORTED: EffortSupport = { state: "unsupported", levels: null };
/** state===supported 但值域提取失败（levels 为 null）——没有判断依据 */
const SUPPORTED_LEVELS_UNKNOWN: EffortSupport = { state: "supported", levels: null };

function config(over: Partial<EffortMappingConfig> = {}): EffortMappingConfig {
  return { aliases: {}, rounding: "down", ...over };
}

describe("resolveEffort：判定顺序 1-4（透传优先于取整）", () => {
  it("requested === none → 原样透传（llama.cpp 原生当关闭思考，不进值域校验）", () => {
    const result = resolveEffort("none", QWEN3_8_SUPPORT, config());
    expect(result).toEqual({ outcome: "passthrough", value: "none" });
  });

  it("none 在 rounding:off 下仍原样透传（判定顺序 1 先于顺序 5）", () => {
    const result = resolveEffort("none", QWEN3_8_SUPPORT, config({ rounding: "off" }));
    expect(result).toEqual({ outcome: "passthrough", value: "none" });
  });

  it("命中别名优先于取整：即使别名目标不在值域内也直接采用（显式配置优先于一切自动策略）", () => {
    const result = resolveEffort(
      "high",
      QWEN3_8_SUPPORT,
      config({ aliases: { high: "xhigh" } }),
    );
    expect(result).toEqual({ outcome: "alias", value: "xhigh" });
  });

  it("别名目标可以是阶梯外的自定义值，一样直接采用", () => {
    const result = resolveEffort("high", QWEN3_8_SUPPORT, config({ aliases: { high: "banana" } }));
    expect(result).toEqual({ outcome: "alias", value: "banana" });
  });

  it("requested 已在支持值域内 → 原样透传，不做别名/取整判断", () => {
    const result = resolveEffort("medium", QWEN3_8_SUPPORT, config());
    expect(result).toEqual({ outcome: "passthrough", value: "medium" });
  });

  it("值域未知（state=unknown）→ 原样透传（没有判断依据不乱动）", () => {
    const result = resolveEffort("high", UNKNOWN_SUPPORT, config());
    expect(result).toEqual({ outcome: "passthrough", value: "high" });
  });

  it("state=unsupported → 原样透传", () => {
    const result = resolveEffort("high", UNSUPPORTED, config());
    expect(result).toEqual({ outcome: "passthrough", value: "high" });
  });

  it("state=supported 但 levels 提取失败（null）→ 原样透传", () => {
    const result = resolveEffort("high", SUPPORTED_LEVELS_UNKNOWN, config());
    expect(result).toEqual({ outcome: "passthrough", value: "high" });
  });
});

describe("resolveEffort：rounding=down", () => {
  it("high → medium（≤high 的最大受支持档）", () => {
    const result = resolveEffort("high", QWEN3_8_SUPPORT, config({ rounding: "down" }));
    expect(result).toEqual({ outcome: "rounded-down", value: "medium" });
  });

  it("minimal → low（没有更低的受支持档，取受支持档中最小者）", () => {
    const result = resolveEffort("minimal", QWEN3_8_SUPPORT, config({ rounding: "down" }));
    expect(result).toEqual({ outcome: "rounded-down", value: "low" });
  });

  it("max → xhigh（≤max 的最大受支持档就是 xhigh 本身）", () => {
    const result = resolveEffort("max", QWEN3_8_SUPPORT, config({ rounding: "down" }));
    expect(result).toEqual({ outcome: "rounded-down", value: "xhigh" });
  });
});

describe("resolveEffort：rounding=up", () => {
  it("high → xhigh（≥high 的最小受支持档）", () => {
    const result = resolveEffort("high", QWEN3_8_SUPPORT, config({ rounding: "up" }));
    expect(result).toEqual({ outcome: "rounded-up", value: "xhigh" });
  });

  it("max → xhigh（没有更高的受支持档，取受支持档中最大者）", () => {
    const result = resolveEffort("max", QWEN3_8_SUPPORT, config({ rounding: "up" }));
    expect(result).toEqual({ outcome: "rounded-up", value: "xhigh" });
  });

  it("minimal → low（≥minimal 的最小受支持档）", () => {
    const result = resolveEffort("minimal", QWEN3_8_SUPPORT, config({ rounding: "up" }));
    expect(result).toEqual({ outcome: "rounded-up", value: "low" });
  });
});

describe("resolveEffort：丢弃字段", () => {
  it("rounding=off 且 requested 需要取整时 → 丢弃（不含 value）", () => {
    const result = resolveEffort("high", QWEN3_8_SUPPORT, config({ rounding: "off" }));
    expect(result).toEqual({ outcome: "dropped" });
    expect(result.value).toBeUndefined();
  });

  it("requested 不在阶梯上（如 banana）→ 丢弃，即使 rounding 不是 off", () => {
    const down = resolveEffort("banana", QWEN3_8_SUPPORT, config({ rounding: "down" }));
    expect(down).toEqual({ outcome: "dropped" });
    const up = resolveEffort("banana", QWEN3_8_SUPPORT, config({ rounding: "up" }));
    expect(up).toEqual({ outcome: "dropped" });
  });

  it("受支持档与阶梯交集为空 → 丢弃（levels 全是阶梯外自定义值）", () => {
    const support: EffortSupport = { state: "supported", levels: ["turbo", "eco"] };
    const result = resolveEffort("high", support, config({ rounding: "down" }));
    expect(result).toEqual({ outcome: "dropped" });
  });
});

describe("resolveEffort：levels 含阶梯外自定义值时不参与取整比较", () => {
  const supportWithCustom: EffortSupport = {
    state: "supported",
    // "turbo" 不在标准阶梯上，不应影响 down/up 的候选计算
    levels: ["xhigh", "medium", "low", "turbo"],
  };

  it("down：high → medium，结果不受 turbo 干扰", () => {
    const result = resolveEffort("high", supportWithCustom, config({ rounding: "down" }));
    expect(result).toEqual({ outcome: "rounded-down", value: "medium" });
  });

  it("up：high → xhigh，结果不受 turbo 干扰", () => {
    const result = resolveEffort("high", supportWithCustom, config({ rounding: "up" }));
    expect(result).toEqual({ outcome: "rounded-up", value: "xhigh" });
  });

  it("requested 本身就是阶梯外自定义值且在 levels 内 → 判定顺序 3 原样透传（不是丢弃）", () => {
    const result = resolveEffort("turbo", supportWithCustom, config({ rounding: "down" }));
    expect(result).toEqual({ outcome: "passthrough", value: "turbo" });
  });
});
