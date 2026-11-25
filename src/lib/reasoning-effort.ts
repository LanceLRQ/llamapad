/**
 * 「思考强度」reasoning_effort 支持判定纯函数
 *
 * llama.cpp 是否支持 reasoning_effort 完全取决于 chat template（jinja）是否读取这个变量，
 * 与模型名无关：模板不读它时，传任何值都静默无效（HTTP 200，但不生效）；模板读取且
 * 校验值域时，传值域外的值会被 jinja 的 raise_exception 直接打成 HTTP 500——而且容器
 * 照常启动、健康检查照常通过（500 只在真正发一次带这个值的推理请求时才暴露），所以
 * 校验必须前置到面板侧（保存配置时 + 启动前），不能指望「容器起不来」暴露问题。
 *
 * 同系列不同打包允许的值域也可能不同（如 Qwen3.8-UD 版模板把 high 额外映射到
 * xhigh，Heretic 版没有这层映射），因此值域只能从当前这份 GGUF 内嵌的模板里现读，
 * 不能按模型名或架构硬编码一张表。
 */

export type EffortState = "supported" | "unsupported" | "unknown";

export interface EffortSupport {
  state: EffortState;
  /** state==="supported" 且能从模板提取出值域时给出；提取不到（或非 supported）为 null */
  levels: string[] | null;
  /** 模板自行应用强度，未读取 enable_thinking。 */
  independentOfThinking?: true;
}

interface ReasoningEffortCaps {
  supports_reasoning_effort?: boolean;
  reasoning_effort_levels?: string[];
  reasoning_effort_rejected?: string[];
}

/** 模板里出现任一变量名即视为支持：不同打包习惯用词不完全一致 */
const SUPPORT_MARKERS = ["reasoning_effort", "reasoning_strength"];

/**
 * 取模板校验使用的档位字典（如 Inkling）或元组（如 Qwen）。
 */
function extractLevels(template: string): string[] | null {
  const map = template.match(/\{%-?\s*set\s+(\w*effort\w*)\s*=\s*\{([^{}]+)\}\s*-?%\}/);
  if (map && new RegExp(`\\bnot\\s+in\\s+${map[1]}\\b`).test(template)) {
    const keys = [...map[2].matchAll(/['"]([^'"]+)['"]\s*:/g)].map((m) => m[1]);
    if (keys.length > 0) return keys;
  }
  const tuple = template.match(/not\s+in\s*\(\s*((?:['"][^'"]*['"]\s*,?\s*)+)\)/);
  if (!tuple) return null;
  const items = [...tuple[1].matchAll(/['"]([^'"]*)['"]/g)].map((m) => m[1]);
  return items.length > 0 ? items : null;
}

/**
 * 判定 GGUF 内嵌的 chat template 是否支持 reasoning_effort。
 * chatTemplate 为 null/空串（GGUF 未内嵌模板，llama.cpp 会退回内置默认模板）时
 * 无从判断——不假装确定，返回 unknown 而非 unsupported。
 */
export function detectReasoningEffort(chatTemplate: string | null, caps?: ReasoningEffortCaps): EffortSupport {
  const supported = caps?.supports_reasoning_effort ??
    (chatTemplate ? SUPPORT_MARKERS.some((marker) => chatTemplate.includes(marker)) : undefined);
  if (supported === undefined) return { state: "unknown", levels: null };
  if (!supported) return { state: "unsupported", levels: null };

  // 引擎只列渲染结果不同的档位。模板仍可声明等效的 high/xhigh/max 别名。
  const levels = new Set([...(caps?.reasoning_effort_levels ?? []), ...(chatTemplate ? extractLevels(chatTemplate) ?? [] : [])]);
  for (const rejected of caps?.reasoning_effort_rejected ?? []) levels.delete(rejected);
  return {
    state: "supported",
    levels: levels.size > 0 ? [...levels] : null,
    ...(chatTemplate && !/\benable_thinking\b/.test(chatTemplate) ? { independentOfThinking: true } : {}),
  };
}

/**
 * 值是否可安全用于该模型：
 * - "inherit" 是本项目自定义的「跟随模板默认」哨兵值，从不下发给 llama.cpp，永远合法
 * - 空串与 "inherit" 同义：`d.effort` 为假值时 model-form.ts 的 deriveOverrides 根本
 *   不产出 reasoning_effort 这个覆盖键（`if (d.effort) server.reasoning_effort = d.effort`），
 *   等价于「不覆盖、跟随默认」。真机复现：没设过思考强度的模型草稿值恒为 ""，若不放行，
 *   这类模型（多数情况）在值域已知时一律保存不了
 * - 非 supported（unsupported / unknown）时没有会抛异常的校验分支在等着，不拦
 * - supported 但提取不到值域（levels 为 null）时同样没有判断依据，不拦
 * - 只有 supported 且值域已知时才真正按值域校验，这是唯一会挡下非法值的分支
 */
export function isEffortAllowed(value: string, support: EffortSupport): boolean {
  if (value === "inherit" || value === "") return true;
  if (support.state !== "supported") return true;
  if (support.levels === null) return true;
  return support.levels.includes(value);
}

/**
 * 保存前是否该拦下这个 reasoning_effort 值。
 *
 * Qwen 等由 enable_thinking 门控的模板，关闭开关后跳过强度校验。
 * Inkling 等独立读取强度的模板始终校验。
 */
export function shouldBlockEffortSave(
  value: string,
  support: EffortSupport,
  thinkingEnabled: boolean,
): boolean {
  if (!thinkingEnabled && !support.independentOfThinking) return false;
  return !isEffortAllowed(value, support);
}

/** 值域未知时的常用档位。none 由模板或引擎确认后展示。 */
const ALL_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * 选择器应列出的档位（不含 "inherit" 与「跟随默认」哨兵，那两项由调用方自行拼接在最前面）：
 * - levels 已知（从模板提取出值域）→ 只列这几档，不列模板不认、选了也会被 isEffortAllowed 拦下的值
 * - levels 未知（unsupported / unknown / supported 但提取失败）→ 列完整枚举，交给用户自行判断
 */
export function effortLevelOptions(support: EffortSupport): string[] {
  return support.levels ?? ALL_LEVELS;
}

export type EffortNote = "thinkingOff" | "unsupported" | "unknown" | "levelsUnknown";

export interface EffortFieldState {
  /** 选择器是否应禁用 */
  disabled: boolean;
  /** 说明文案的 code，由调用方按 code 映射到 i18n key；null = 无需展示任何提示 */
  note: EffortNote | null;
}

/**
 * 选择器的禁用态与说明文案三态判定（UI 组件直接消费，不必自己写分支）。
 *
 * 模板独立读取强度时，选择器始终可用。
 */
export function effortFieldState(support: EffortSupport, thinkingEnabled: boolean): EffortFieldState {
  if (!thinkingEnabled && !support.independentOfThinking) return { disabled: true, note: "thinkingOff" };
  if (support.state === "unsupported") return { disabled: true, note: "unsupported" };
  if (support.state === "unknown") return { disabled: false, note: "unknown" };
  if (support.levels === null) return { disabled: false, note: "levelsUnknown" };
  return { disabled: false, note: null };
}
