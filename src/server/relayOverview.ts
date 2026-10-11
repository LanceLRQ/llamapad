import type Database from "better-sqlite3";
import { mergeConfig } from "../core/config";
import { llamaUpstreamBase } from "./llamaProxy";
import { decorateRuntimeStatus, type RunningModelView } from "./modelsView";
import { createModelRepo } from "./repo/models";
import type { RuntimeService } from "./runtime";

/**
 * API 中转页「托管服务」卡片的数据装配：在运行状态视图上补两样东西——面板实际
 * 访问该模型用的上游地址，以及合并后生效的关键参数。只读，不触发任何探测以外的 IO。
 */

/** 卡片上展示的关键参数（合并 default 与模型 overrides 之后的生效值） */
export interface ManagedServiceParams {
  image: string;
  gpu: string;
  ctxSize: number;
  gpuLayers: number;
  reasoningEffort: string;
  effortRounding: string;
  /** 思考强度别名表的条目数；明细在模型编辑页看 */
  effortAliasCount: number;
  specType: string;
}

export interface ManagedServiceView extends RunningModelView {
  isDefault: boolean;
  /** 面板侧访问该模型的地址；端口未知时为 null */
  upstreamBase: string | null;
  /** 模型行已删时为 null */
  params: ManagedServiceParams | null;
}

export interface RelayOverview {
  defaultModel: string | null;
  services: ManagedServiceView[];
}

export async function buildRelayOverview(
  db: Database.Database,
  runtime: RuntimeService,
  probe?: (hostPort: number) => Promise<boolean>,
): Promise<RelayOverview> {
  const status = await decorateRuntimeStatus(db, runtime, probe);
  const repo = createModelRepo(db);
  const defaults = repo.getDefaultConfig();

  const services = status.models.map((entry): ManagedServiceView => {
    const row = repo.getModel(entry.model);
    const merged = row ? mergeConfig(defaults, row.overrides ?? {}) : null;
    return {
      ...entry,
      isDefault: status.defaultModel === entry.model,
      upstreamBase: entry.hostPort !== null ? llamaUpstreamBase(entry.hostPort) : null,
      params: merged
        ? {
            image: merged.docker.image,
            gpu: merged.docker.gpu,
            ctxSize: merged.server.ctx_size,
            gpuLayers: merged.server.gpu_layers,
            reasoningEffort: merged.server.reasoning_effort,
            effortRounding: merged.api.effort_rounding,
            effortAliasCount: Object.keys(merged.api.effort_aliases).length,
            specType: merged.server.spec_type,
          }
        : null,
    };
  });

  return { defaultModel: status.defaultModel, services };
}
