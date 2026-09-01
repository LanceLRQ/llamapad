import type Database from "better-sqlite3";
import path from "node:path";
import { mergeConfig } from "../core/config";
import type { EffortMappingConfig } from "../lib/effort-mapping";
import { detectReasoningEffort, type EffortSupport } from "../lib/reasoning-effort";
import { resolveModelFiles } from "./fsScanner";
import { getGgufMeta } from "./ggufMeta";
import { createModelRepo } from "./repo/models";

/**
 * 「思考强度中转映射」的上下文组装（最后一批：接线用）
 *
 * lib/proxy-rewrite.ts 的改写函数只认 EffortSupport + EffortMappingConfig 两个纯数据，
 * 不碰 db / fs——这两样上下文怎么拿到是本文件唯一的职责。与
 * runtime.ts 的 assertReasoningEffortAllowed（校验用途，拿的是 server.reasoning_effort
 * 单值）故意不合并：那边校验的是"模型自己配的固定值合不合法"，这里要的是"客户端
 * 每次请求传的任意值该怎么改写"，取的是 api 段而非 server.reasoning_effort，返回形态
 * 也不同，硬凑一个函数只会让两条判定路径互相绕。
 *
 * 放在 server/ 而非 lib/：全程要查 db（模型行）与文件系统（GGUF 元数据缓存），
 * 是纯 IO 组装，不是可测的判定逻辑本身——判定逻辑已经在 lib 两处纯函数里。
 * 单独成一个小文件而非塞进 runtime.ts：runtime.ts 是模型生命周期管理（启停/排空/校验），
 * 这里是中转代理层的上下文装配，关注点不同，凑一起只会让 runtime.ts 更难读。
 */
export interface EffortMappingContext {
  support: EffortSupport;
  config: EffortMappingConfig;
}

/** 模型不存在 / gguf 文件解析不到时的降级态：resolveEffort 对 unknown 是原样透传，安全 */
const UNKNOWN_SUPPORT: EffortSupport = { state: "unknown", levels: null };

/**
 * 组装反代改写所需的上下文：
 * 1. api 段配置（别名表 + 取整方向）——不论模型是否存在都能拿到（不存在时用全局默认，
 *    不存在的模型不该让整个中转层失去改写能力，只是 support 会降级为 unknown 而已）
 * 2. 该模型的 reasoning_effort 支持态——模型行不存在、或 gguf 文件缺失/未命中时
 *    降级为 unknown，不抛错（调用方是请求路径上的编排层，没有"报错给客户端"的余地）
 */
export async function getEffortMappingContext(
  db: Database.Database,
  modelsRoot: string,
  modelName: string,
): Promise<EffortMappingContext> {
  const repo = createModelRepo(db);
  const model = repo.getModel(modelName);
  const apiConfig = mergeConfig(repo.getDefaultConfig(), model?.overrides ?? {}).api;
  const config: EffortMappingConfig = { aliases: apiConfig.effort_aliases, rounding: apiConfig.effort_rounding };

  if (model === null) {
    return { support: UNKNOWN_SUPPORT, config };
  }

  const resolved = resolveModelFiles(modelsRoot, model.gguf_file);
  const firstFile = resolved.files[0];
  if (resolved.missing || firstFile === undefined) {
    return { support: UNKNOWN_SUPPORT, config };
  }

  const meta = await getGgufMeta(db, path.join(modelsRoot, firstFile.rel));
  const support = detectReasoningEffort(meta?.chatTemplate ?? null);
  return { support, config };
}
