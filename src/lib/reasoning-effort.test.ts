import { describe, expect, it } from "vitest";
import {
  detectReasoningEffort,
  effortFieldState,
  effortLevelOptions,
  isEffortAllowed,
} from "./reasoning-effort";

/**
 * 三份夹具均取自实测过的真实 GGUF chat template（不自造），覆盖
 * 「支持且值域可提取 / 不支持 / 无模板可判断」三态。
 */

/** Qwen3.8-27B-UD：支持 reasoning_effort，值域 xhigh/medium/low，且有 high→xhigh 别名 */
const QWEN3_8_UD_TEMPLATE = `
{%- if enable_thinking is undefined or enable_thinking is true %}
    {%- set resolved_reasoning_effort = reasoning_effort|default('xhigh') %}
    {%- if resolved_reasoning_effort == 'high' %}
        {%- set resolved_reasoning_effort = 'xhigh' %}
    {%- endif %}
    {%- if resolved_reasoning_effort not in ('xhigh', 'medium', 'low') %}
        {{- raise_exception('Unexpected reasoning effort ' ~ reasoning_effort ~ '. Supported types are xhigh (default), medium, and low.') }}
    {%- endif %}
{%- endif %}
`;

/** Qwen3.6 / gemma4 一类：含 enable_thinking 但不含 reasoning_effort，变量传了也静默无效 */
const UNSUPPORTED_TEMPLATE = `
{%- if enable_thinking is defined and enable_thinking is false %}
    {{- '<think>\\n\\n</think>\\n\\n' }}
{%- endif %}
`;

describe("detectReasoningEffort", () => {
  it("chatTemplate 为 null → unknown（没有模板无从判断，不假装确定）", () => {
    expect(detectReasoningEffort(null)).toEqual({ state: "unknown", levels: null });
  });

  it("chatTemplate 为空串 → unknown（等同没有内嵌模板）", () => {
    expect(detectReasoningEffort("")).toEqual({ state: "unknown", levels: null });
  });

  it("含 reasoning_effort → supported，且按模板中出现的顺序提取出值域", () => {
    const result = detectReasoningEffort(QWEN3_8_UD_TEMPLATE);
    expect(result.state).toBe("supported");
    expect(result.levels).toEqual(["xhigh", "medium", "low"]);
  });

  it("含 reasoning_strength（同义变量名）同样判定为 supported", () => {
    const template = "{%- if reasoning_strength not in (\"low\", \"high\") %}{%- endif %}";
    const result = detectReasoningEffort(template);
    expect(result.state).toBe("supported");
    expect(result.levels).toEqual(["low", "high"]);
  });

  it("不含 reasoning_effort/reasoning_strength → unsupported，传值静默无效", () => {
    expect(detectReasoningEffort(UNSUPPORTED_TEMPLATE)).toEqual({ state: "unsupported", levels: null });
  });

  it("supported 但值域不是元组排除写法（如 if/elif 链）时，提取不到就返回 levels:null，不瞎猜", () => {
    const template = `
      {%- if reasoning_effort == 'low' %}
      {%- elif reasoning_effort == 'high' %}
      {%- endif %}
    `;
    const result = detectReasoningEffort(template);
    expect(result.state).toBe("supported");
    expect(result.levels).toBeNull();
  });

  it("引号可以是双引号，元素间可以没有空格", () => {
    const template = '{%- if x not in ("a","b","c") %}{%- endif %}reasoning_effort';
    expect(detectReasoningEffort(template).levels).toEqual(["a", "b", "c"]);
  });
});

describe("isEffortAllowed", () => {
  const supportedKnown = detectReasoningEffort(QWEN3_8_UD_TEMPLATE); // levels: xhigh/medium/low
  const supportedUnknownLevels = { state: "supported", levels: null } as const;
  const unsupported = detectReasoningEffort(UNSUPPORTED_TEMPLATE);
  const unknown = detectReasoningEffort(null);

  it('"inherit" 永远合法：不发给 llama.cpp，不触发任何模板校验分支', () => {
    expect(isEffortAllowed("inherit", supportedKnown)).toBe(true);
    expect(isEffortAllowed("inherit", supportedUnknownLevels)).toBe(true);
    expect(isEffortAllowed("inherit", unsupported)).toBe(true);
    expect(isEffortAllowed("inherit", unknown)).toBe(true);
  });

  it("levels 已知：值在值域内通过，值域外拒绝", () => {
    expect(isEffortAllowed("xhigh", supportedKnown)).toBe(true);
    expect(isEffortAllowed("medium", supportedKnown)).toBe(true);
    expect(isEffortAllowed("max", supportedKnown)).toBe(false);
  });

  it("levels 未知（supported 但提取不到值域）：没有判断依据，一律放行", () => {
    expect(isEffortAllowed("max", supportedUnknownLevels)).toBe(true);
    expect(isEffortAllowed("anything", supportedUnknownLevels)).toBe(true);
  });

  it("unsupported：模板不读这个变量，传什么都不会引发校验异常，不拦", () => {
    expect(isEffortAllowed("xhigh", unsupported)).toBe(true);
    expect(isEffortAllowed("bogus", unsupported)).toBe(true);
  });

  it("unknown（无模板可判断）：没有判断依据，不拦", () => {
    expect(isEffortAllowed("xhigh", unknown)).toBe(true);
  });
});

describe("effortLevelOptions", () => {
  it("levels 已知：只列模板值域里的这几档，按模板中出现的顺序", () => {
    const support = detectReasoningEffort(QWEN3_8_UD_TEMPLATE); // xhigh/medium/low
    expect(effortLevelOptions(support)).toEqual(["xhigh", "medium", "low"]);
  });

  it("levels 未知（unsupported / unknown / 提取失败）：列出完整枚举兜底", () => {
    const fullEnum = ["minimal", "low", "medium", "high", "xhigh", "max"];
    expect(effortLevelOptions(detectReasoningEffort(UNSUPPORTED_TEMPLATE))).toEqual(fullEnum);
    expect(effortLevelOptions(detectReasoningEffort(null))).toEqual(fullEnum);
    expect(effortLevelOptions({ state: "supported", levels: null })).toEqual(fullEnum);
  });
});

describe("effortFieldState", () => {
  const supportedKnown = detectReasoningEffort(QWEN3_8_UD_TEMPLATE);
  const supportedUnknownLevels = { state: "supported", levels: null } as const;
  const unsupported = detectReasoningEffort(UNSUPPORTED_TEMPLATE);
  const unknown = detectReasoningEffort(null);

  it("enable_thinking 关闭时优先级最高：无论支持态如何，一律禁用且给出「思考已关闭」的理由", () => {
    expect(effortFieldState(supportedKnown, false)).toEqual({ disabled: true, note: "thinkingOff" });
    expect(effortFieldState(unsupported, false)).toEqual({ disabled: true, note: "thinkingOff" });
  });

  it("unsupported 且思考开启：禁用，理由是模板不读这个变量", () => {
    expect(effortFieldState(unsupported, true)).toEqual({ disabled: true, note: "unsupported" });
  });

  it("unknown 且思考开启：可用，但给出「无法确认」的提示", () => {
    expect(effortFieldState(unknown, true)).toEqual({ disabled: false, note: "unknown" });
  });

  it("supported 但值域提取不到：可用，提示允许值未能确定", () => {
    expect(effortFieldState(supportedUnknownLevels, true)).toEqual({
      disabled: false,
      note: "levelsUnknown",
    });
  });

  it("supported 且值域已知、思考开启：可用，无需额外提示", () => {
    expect(effortFieldState(supportedKnown, true)).toEqual({ disabled: false, note: null });
  });
});
