import type Database from "better-sqlite3";
import { clearDefaultUpstream, getUpstream, setDefaultUpstream } from "./repo/upstreams";
import { DefaultModelNotRunningError, type RuntimeService } from "./runtime";

/** PUT /api/v1/runtime/default-model 的决议结果，由 route 映射成状态码 */
export type DefaultModelChoice =
  | { kind: "ok" }
  | { kind: "upstream-disabled" }
  | { kind: "not-running"; message: string };

/**
 * 把 model 设为默认模型：
 * - 是外部上游：启用则落库（settings.default_upstream），已停用返回 upstream-disabled、不改库
 * - 否则按托管模型处理：先设托管默认，成功后再清 default_upstream
 *   （模型没在跑时抛错，不能把用户原来的默认上游弄丢）
 */
export async function chooseDefaultModel(
  db: Database.Database,
  runtime: RuntimeService,
  model: string,
): Promise<DefaultModelChoice> {
  const upstream = getUpstream(db, model);
  if (upstream !== null) {
    if (!upstream.enabled) return { kind: "upstream-disabled" };
    setDefaultUpstream(db, model);
    return { kind: "ok" };
  }

  try {
    await runtime.setDefaultModel(model);
  } catch (error) {
    if (error instanceof DefaultModelNotRunningError) return { kind: "not-running", message: error.message };
    throw error;
  }
  clearDefaultUpstream(db);
  return { kind: "ok" };
}
