import { mergeModelLists, orderForModelsList, type ModelsListBody } from "../lib/models-list";
import { enhanceModelsResponse } from "../lib/proxy-rewrite";
import type { EffortMappingContext } from "./effortContext";
import { llamaUpstreamBase } from "./llamaProxy";
import type { RunningModel } from "./runtime";

/**
 * /v1/models 聚合的 IO 编排（多模型并行，决策 D7）：并发拉取每个运行中模型的
 * /v1/models，按模型注入思考强度能力声明，再交给 lib/models-list.ts 合并。
 *
 * 拉不到的模型（端口未知、还在加载返回 503、连接失败）直接不出现在列表里：
 * 列表的语义是「现在能用的模型」，客户端选中一个还没就绪的模型只会拿到 502。
 * 超时比 health 采集短：这个接口挂在客户端的模型选择界面上，一个卡住的实例不能
 * 拖慢整个列表。
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const UPSTREAM_TIMEOUT_MS = 1_500;

export interface ModelsListDeps {
  fetch?: FetchLike;
  /** 取某个模型的思考强度映射上下文（生产为 effortContext.getEffortMappingContext） */
  loadEffortContext: (model: string) => Promise<EffortMappingContext>;
}

export async function buildAggregatedModelsList(
  models: readonly RunningModel[],
  defaultModel: string | null,
  deps: ModelsListDeps,
): Promise<ModelsListBody> {
  const fetchImpl: FetchLike = deps.fetch ?? fetch;
  const entries = await Promise.all(
    orderForModelsList(models, defaultModel).map(async (entry) => {
      if (entry.hostPort === null) return { model: entry.model, body: null };
      try {
        const res = await fetchImpl(`${llamaUpstreamBase(entry.hostPort)}/v1/models`, {
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        });
        if (!res.ok) return { model: entry.model, body: null };
        const raw = await res.text();
        const { support, config } = await deps.loadEffortContext(entry.model);
        return { model: entry.model, body: enhanceModelsResponse(raw, support, config) };
      } catch {
        return { model: entry.model, body: null };
      }
    }),
  );
  return mergeModelLists(entries);
}
