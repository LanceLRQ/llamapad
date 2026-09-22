import { partialServerConfigSchema, type ServerConfig } from "@/core/schemas";

/**
 * 「新建模型」向导的深链构造与解析（档案页 README 推荐卡「应用到建配置」
 * 后，单卡「创建配置」也要带上同一份推荐参数）。page.tsx（服务端组件）与
 * repo-detail-view.tsx（客户端组件）两端都要用，不放进 lib/batch-create-params.ts
 * ——那个文件类型上依赖 @/server/repo/presets 的 ParamPreset，语义上不属于
 * 「两端都能直接 import」这一档，单独开一个不碰 server-only 模块的文件。
 */

/** `/models/new?file=<rel>` 深链，server 非空时追加 `&server=<json>`，
 *  from 非空时再追加 `&from=<来源页路径>`（顺序固定 file → server → from，
 *  向导「返回来源页」按钮靠它找回入口，见 `resolveBackTarget`）。
 *  server 为空对象时不追加这个查询参数——向导页没有推荐参数时的既有形态，
 *  不产出一个解析出来恒为 {} 的多余参数；from 同理，不传就不追加，三个
 *  既有调用方（不传 from）产出的 URL 与改动前逐字一致 */
export function newModelHref(file: string, server: Partial<ServerConfig>, from?: string): string {
  let href = `/models/new?file=${encodeURIComponent(file)}`;
  if (Object.keys(server).length > 0) href += `&server=${encodeURIComponent(JSON.stringify(server))}`;
  if (from !== undefined && from !== "") href += `&from=${encodeURIComponent(from)}`;
  return href;
}

/** 向导「返回来源页」按钮的落点与文案键。 */
export type BackTarget = {
  /** 返回按钮的跳转地址 */
  href: string;
  /** 按钮文案的 i18n 键，位于 pages.modelsNew 命名空间下 */
  labelKey: "backToRepo" | "backToFiles" | "backToList";
};

/** 仓库档案页形状：`/models/repos/<纯数字 id>`，完全锚定、不允许多余路径段。
 *  仓库 id 在库里是 number，收成 `\d+` 而不是 `[^/]+`——后者会连
 *  `/models/repos/1/edit` 这种带额外路径段的都吃进来，那不是「档案页」 */
const REPO_BACK_PATTERN = /^\/models\/repos\/\d+$/;

/**
 * 由 `?from=` 解析向导「返回来源页」按钮的落点，**白名单判定，只认两种
 * 形状**（仓库档案页 / 文件管理页），其余一律落默认值「返回配置列表」。
 *
 * 为什么是白名单而不是「非空就原样跳」：`from` 来自 URL 查询参数，任何人
 * 都能改写成任意值。若不加甄别地把它原样当跳转地址用，这个「返回」按钮就
 * 变成了一个开放重定向跳板——`//evil.com` 在浏览器里是协议相对 URL（沿用
 * 当前协议补全成 `https://evil.com`），`https://evil.com` 更直接，两者都会
 * 把点了「返回」的用户真的带出站；`/models/repos/1/../../x` 这类带路径穿越
 * 的输入同样不能信任。白名单只放行两种已知合法形状，其余（含空值、非法
 * 形状、站外地址、带 query/fragment 的变体）一律吃掉、落回站内的默认出口，
 * 从根上不给「原样跳转」这条路留口子。
 *
 * 正则用 `^...$` 完整锚定而不是 `startsWith`：后者会放过
 * `/models/repos/1-evil` 之类看似前缀匹配、实际另有所指的输入。
 */
export function resolveBackTarget(from: string | undefined): BackTarget {
  if (from !== undefined && REPO_BACK_PATTERN.test(from)) {
    return { href: from, labelKey: "backToRepo" };
  }
  if (from === "/files") {
    return { href: "/files", labelKey: "backToFiles" };
  }
  return { href: "/models/profiles", labelKey: "backToList" };
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
