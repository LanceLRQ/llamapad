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
}

/** 模板里出现任一变量名即视为支持：不同打包习惯用词不完全一致 */
const SUPPORT_MARKERS = ["reasoning_effort", "reasoning_strength"];

/**
 * 从模板里提取形如 `not in ('xhigh', 'medium', 'low')` 的值域元组。
 * 引号可能是单引号或双引号，元素间可能有空格；按模板中出现的顺序返回。
 * 匹配不到（模板校验方式不是这种元组排除写法，比如改用 if/elif 链）返回 null，
 * 调用方据此降级提示，不瞎猜一个列表出来。
 */
function extractLevels(template: string): string[] | null {
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
export function detectReasoningEffort(chatTemplate: string | null): EffortSupport {
  if (chatTemplate === null || chatTemplate === "") {
    return { state: "unknown", levels: null };
  }
  const supported = SUPPORT_MARKERS.some((marker) => chatTemplate.includes(marker));
  if (!supported) {
    return { state: "unsupported", levels: null };
  }
  return { state: "supported", levels: extractLevels(chatTemplate) };
}

/**
 * 值是否可安全用于该模型：
 * - "inherit" 是本项目自定义的「跟随模板默认」哨兵值，从不下发给 llama.cpp，永远合法
 * - 非 supported（unsupported / unknown）时没有会抛异常的校验分支在等着，不拦
 * - supported 但提取不到值域（levels 为 null）时同样没有判断依据，不拦
 * - 只有 supported 且值域已知时才真正按值域校验，这是唯一会挡下非法值的分支
 */
export function isEffortAllowed(value: string, support: EffortSupport): boolean {
  if (value === "inherit") return true;
  if (support.state !== "supported") return true;
  if (support.levels === null) return true;
  return support.levels.includes(value);
}

/** 完整值域兜底（levels 提取不到时展示）：与 core/schemas.ts 的 reasoningEffortSchema 值域一致，
 *  但故意不从那边导入——lib 层不反向依赖 core 的 zod schema，独立维护这一份字面量 */
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
 * thinkingEnabled 的优先级高于 support 的判定：实测模板里 reasoning_effort 分支整段
 * 包在 enable_thinking 的判断内，关闭思考后这个字段配了也不参与渲染——必须先禁用，
 * 且理由与「模板本来就不支持」不同，不能合并成一种提示。
 */
export function effortFieldState(support: EffortSupport, thinkingEnabled: boolean): EffortFieldState {
  if (!thinkingEnabled) return { disabled: true, note: "thinkingOff" };
  if (support.state === "unsupported") return { disabled: true, note: "unsupported" };
  if (support.state === "unknown") return { disabled: false, note: "unknown" };
  if (support.levels === null) return { disabled: false, note: "levelsUnknown" };
  return { disabled: false, note: null };
}
