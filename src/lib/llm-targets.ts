/**
 * AI 解析目标（LlmTarget）判定纯函数
 *
 * 「AI 解析 README 推荐参数」的引擎选择从全局设置改为解析时现选：候选 =
 * 已配齐的外部 API（至多一项）+ 每个正在运行的本地模型（0..N 项）。本文件
 * 只产出候选集构建 / id 编解码 / 按 id 反解这三个纯判定，不落库、不记忆，
 * 接线（路由、UI）由消费方完成。
 */

/** AI 解析目标：外部 API 或某个正在运行的本地模型 */
export type LlmTarget = { kind: "external"; model: string } | { kind: "local"; model: string };

/** 构建候选集所需的原始信息，均由调用方（路由层）现查现传，不做缓存 */
export interface LlmTargetInput {
  /** 外部 API 三项（baseUrl/apiKey/model）是否配齐 */
  externalReady: boolean;
  /** 外部 API 配置里的模型名；externalReady 为 false 时通常是 null */
  externalModel: string | null;
  /** 当前正在运行、且拿得到 hostPort 的本地模型名，按服务端给出的顺序 */
  runningModels: string[];
}

/**
 * 构建候选集：外部在前、本地按 runningModels 传入顺序在后。
 * 顺序即默认策略——UI 默认选中 [0]，配了外部就默认外部（本地解析会占用
 * 推理槽位、与 Playground 抢资源，不应作为默认）。
 */
export function buildLlmTargets(input: LlmTargetInput): LlmTarget[] {
  const targets: LlmTarget[] = [];

  if (input.externalReady && input.externalModel !== null && input.externalModel.trim() !== "") {
    targets.push({ kind: "external", model: input.externalModel });
  }

  const seen = new Set<string>();
  for (const model of input.runningModels) {
    if (model.trim() === "") continue; // 空串 / 纯空白项跳过
    if (seen.has(model)) continue; // 去重，保留首次出现的位置
    seen.add(model);
    targets.push({ kind: "local", model });
  }

  return targets;
}

/** 目标 → 稳定字符串 id（用于前端选择器 value 与路由入参） */
export function llmTargetId(target: LlmTarget): string {
  return target.kind === "external" ? "external" : `local:${target.model}`;
}

/**
 * 按 id 从候选集里反解目标——这是服务端的安全闸门。路由拿前端传来的 id
 * 调这个函数，映射不回当前候选集就拒绝请求；不能因为 id 形如 "local:xxx"
 * 就直接构造一个 local target 走捷径（那样会绕过"该模型是否真的在跑"这层
 * 校验），必须真的在 buildLlmTargets(input) 的结果里命中同一个 id 才算数。
 */
export function resolveLlmTarget(input: LlmTargetInput, id: string): LlmTarget | null {
  const targets = buildLlmTargets(input);
  return targets.find((target) => llmTargetId(target) === id) ?? null;
}
