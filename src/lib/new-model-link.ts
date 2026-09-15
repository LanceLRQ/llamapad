import { partialServerConfigSchema, type ServerConfig } from "@/core/schemas";

/**
 * 「新建模型」向导的深链构造与解析（档案页 README 推荐卡「应用到建配置」
 * 后，单卡「创建配置」也要带上同一份推荐参数）。page.tsx（服务端组件）与
 * repo-detail-view.tsx（客户端组件）两端都要用，不放进 lib/batch-create-params.ts
 * ——那个文件类型上依赖 @/server/repo/presets 的 ParamPreset，语义上不属于
 * 「两端都能直接 import」这一档，单独开一个不碰 server-only 模块的文件。
 */

/** `/models/new?file=<rel>` 深链，server 非空时追加 `&server=<json>`。
 *  server 为空对象时不追加这个查询参数——向导页没有推荐参数时的既有形态，
 *  不产出一个解析出来恒为 {} 的多余参数 */
export function newModelHref(file: string, server: Partial<ServerConfig>): string {
  const base = `/models/new?file=${encodeURIComponent(file)}`;
  if (Object.keys(server).length === 0) return base;
  return `${base}&server=${encodeURIComponent(JSON.stringify(server))}`;
}

/**
 * `?server=` 查询参数原始字符串 → `Partial<ServerConfig>`。JSON 解析失败、
 * 字段不合法（`partialServerConfigSchema` 是 strict-partial，未知键/超出值域
 * 都直接拒绝）、或解出空对象，一律返回 `undefined`——调用方据此判断「没有
 * 可用的推荐参数」，不必再自己判空。
 */
export function parseServerParam(raw: string | undefined): Partial<ServerConfig> | undefined {
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const result = partialServerConfigSchema.safeParse(parsed);
  if (!result.success || Object.keys(result.data).length === 0) return undefined;
  return result.data;
}
