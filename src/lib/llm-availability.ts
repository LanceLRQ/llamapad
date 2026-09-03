/**
 * AI 解析引擎可用性判定（批 3）
 *
 * 从 `llm-extract-panel.tsx` 下沉：本仓库组件测不了（vitest 是 node 环境无
 * jsdom），可测判定一律下沉 `src/lib/*.ts`，这是这批任务（`recommend-tabs.ts` /
 * `readme-verify.ts` 等）一路守着的纪律。
 *
 * 三种不可用原因优先级固定、互斥：
 * 1. `disabled`  —— 引擎整个没启用（设置页选了「不用」）
 * 2. `incomplete` —— 选了外部 API 但 baseUrl/apiKey/model 没配全
 * 3. `noModel`    —— 选了本地模型但当前没有模型在运行
 *
 * `state === null` 表示引擎状态还没从 `/api/v1/settings/llm` 取回，此时不下
 * 判断（既不是可用也不是不可用的某一种），调用方按「未知」处理。
 */

export interface LlmEngineState {
  engine: "none" | "local" | "external";
  externalReady: boolean;
  missing: string[];
  hasRunningModel: boolean;
}

export type LlmUnavailableReason = "disabled" | "incomplete" | "noModel" | null;

export function describeUnavailable(state: LlmEngineState | null): LlmUnavailableReason {
  if (state === null) return null;
  if (state.engine === "none") return "disabled";
  if (state.engine === "external" && !state.externalReady) return "incomplete";
  if (state.engine === "local" && !state.hasRunningModel) return "noModel";
  return null;
}
