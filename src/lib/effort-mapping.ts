import type { EffortSupport } from "./reasoning-effort";

/**
 * 「思考强度中转映射」算法（第一批：只做数据模型与算法，接线在下一批）
 *
 * 背景：面板给外部客户端（Cherry Studio、OpenWebUI 等）提供 OpenAI 兼容中转入口，
 * 客户端会发 reasoning_effort，但每个模型的 chat template 接受的档位不同——
 * Qwen3.8 系模板只认 xhigh/medium/low，客户端常发的 high/max/minimal 在这些模板
 * 上会让 llama-server 抛 HTTP 500（jinja raise_exception，见 reasoning-effort.ts
 * 文件头注释）。这里实现的是"客户端发什么都能正常工作"的改写层：面板把值
 * 就近改写成该模型能接受的，改写不了就干脆丢弃这个字段，让模板走自己的默认值
 * （兜底策略，不是报错——保证请求一定能成功）。
 *
 * 有序阶梯（"none" 不参与取整，它是"关闭思考"的哨兵值而非强度档，见判定顺序 1）。
 */
const EFFORT_LADDER = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
type EffortLadderValue = (typeof EFFORT_LADDER)[number];

/** 面板 api 段配置（对应 core/schemas.ts 的 api.effort_aliases / api.effort_rounding） */
export interface EffortMappingConfig {
  /** 显式别名表：requested → 目标值，命中时优先于一切自动取整策略，不再做值域校验 */
  aliases: Record<string, string>;
  /** 值域外时的取整方向；"off" 表示不取整，直接丢弃字段 */
  rounding: "down" | "up" | "off";
}

/**
 * 本次决议实际发生了什么：
 * - passthrough：原样透传（none / 已在值域内 / 没有判断依据）
 * - alias：命中显式别名表
 * - rounded-down / rounded-up：就近取整
 * - dropped：丢弃字段，让模板走自身默认
 */
export type EffortOutcome = "passthrough" | "alias" | "rounded-down" | "rounded-up" | "dropped";

export interface EffortResolution {
  outcome: EffortOutcome;
  /** 最终应下发的值；仅 dropped 时缺席（调用方据此从请求体里删掉 reasoning_effort） */
  value?: string;
}

/**
 * 决议客户端传入的 reasoning_effort 应如何改写。
 *
 * 判定顺序本身是规格（来自「思考强度中转映射」特性设计），不要重排：
 * 1. none 原样透传（llama.cpp 原生当"关闭思考"处理，实测不进模板值域校验）
 * 2. 命中别名 → 用别名结果（显式配置优先于一切自动策略，不做值域校验）
 * 3. 已在支持值域内 → 原样透传
 * 4. 值域未知（非 supported，或 supported 但 levels 提取失败）→ 原样透传，
 *    没有判断依据时不乱动
 * 5. rounding === "off" → 丢弃字段
 * 6. requested 不在阶梯上（如客户端发了 "banana"）→ 丢弃字段
 * 7. 就近取整：受支持档先与阶梯取交集（levels 里可能有阶梯外自定义值，
 *    那些不参与取整比较），再在交集里按 down/up 规则找候选；找不到候选时
 *    down 兜底取交集最小者、up 兜底取交集最大者；交集为空则丢弃
 */
export function resolveEffort(
  requested: string,
  support: EffortSupport,
  config: EffortMappingConfig,
): EffortResolution {
  if (requested === "none") {
    return { outcome: "passthrough", value: requested };
  }

  const aliased = config.aliases[requested];
  if (aliased !== undefined) {
    return { outcome: "alias", value: aliased };
  }

  if (support.levels?.includes(requested)) {
    return { outcome: "passthrough", value: requested };
  }

  if (support.state !== "supported" || support.levels === null) {
    return { outcome: "passthrough", value: requested };
  }

  if (config.rounding === "off") {
    return { outcome: "dropped" };
  }

  const requestedIndex = EFFORT_LADDER.indexOf(requested as EffortLadderValue);
  if (requestedIndex === -1) {
    return { outcome: "dropped" };
  }

  // 阶梯升序遍历，天然得到升序排列的交集（levels 顺序不定，不能直接拿来比较）
  const levels = support.levels;
  const candidates = EFFORT_LADDER.filter((level) => levels.includes(level));
  if (candidates.length === 0) {
    return { outcome: "dropped" };
  }

  if (config.rounding === "down") {
    // 升序遍历取最后一个满足 ≤ requested 的候选，即为其中的最大者
    let picked: EffortLadderValue | undefined;
    for (const level of candidates) {
      if (EFFORT_LADDER.indexOf(level) <= requestedIndex) picked = level;
    }
    return { outcome: "rounded-down", value: picked ?? candidates[0] };
  }

  // up：升序遍历取第一个满足 ≥ requested 的候选，即为其中的最小者
  const picked = candidates.find((level) => EFFORT_LADDER.indexOf(level) >= requestedIndex);
  return { outcome: "rounded-up", value: picked ?? candidates[candidates.length - 1] };
}
