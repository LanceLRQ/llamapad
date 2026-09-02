import type { ServerConfig } from "@/core/schemas";
import type { ParamPreset } from "@/server/repo/presets";

import type { RecommendedProfile } from "./readme-params";
import { recommendDiff, selectedServer } from "./recommend-diff";

/**
 * 「批量创建配置」弹层的参数下拉（README 推荐参数抽取 T19）：三档选项——
 * 走全局默认 / 本仓库推荐（README profiles） / 我的预设（GET /api/v1/presets
 * 全量结果，不按 source 过滤）——解析成实际要写进 overrides.server 的对象，
 * 以及摘要 chip 的文案。都是纯函数，组件只管拿 Select 的受控值调这里。
 */

export const DEFAULT_PARAM_PICK = "default";

const PROFILE_PREFIX = "profile:";
const PRESET_PREFIX = "preset:";

export type ParamPick =
  | { kind: "default" }
  | { kind: "profile"; id: string }
  | { kind: "preset"; id: number };

export function profilePickValue(id: string): string {
  return `${PROFILE_PREFIX}${id}`;
}

export function presetPickValue(id: number): string {
  return `${PRESET_PREFIX}${id}`;
}

/** Select 的受控值 → 判别联合。未知前缀 / 非法数字 id 一律归到 default，
 *  不让一个解析不出来的选项把弹层的其余部分带崩 */
export function parseParamPick(value: string): ParamPick {
  if (value.startsWith(PROFILE_PREFIX)) return { kind: "profile", id: value.slice(PROFILE_PREFIX.length) };
  if (value.startsWith(PRESET_PREFIX)) {
    const id = Number(value.slice(PRESET_PREFIX.length));
    return Number.isFinite(id) ? { kind: "preset", id } : { kind: "default" };
  }
  return { kind: "default" };
}

/** README 推荐 → 只取采样类字段（与 recommend-profile-card.tsx 的默认勾选
 *  同一口径，见 lib/recommend-diff.ts 的取舍说明） */
function samplingOnlyServer(
  profile: RecommendedProfile,
  effective: ServerConfig,
): Partial<ServerConfig> {
  const rows = recommendDiff(profile.server, effective);
  const selected = new Set(rows.filter((row) => row.defaultChecked).map((row) => row.field));
  return selectedServer(rows, selected);
}

/** 下拉当前选中值 → 要写进 overrides.server 的对象。选不到（profile/preset
 *  已经不在列表里）一律退回 {}，等价于「走全局默认」，不抛错 */
export function paramServerForPick(
  pick: string,
  profiles: readonly RecommendedProfile[],
  presets: readonly ParamPreset[],
  effective: ServerConfig,
): Partial<ServerConfig> {
  const parsed = parseParamPick(pick);
  if (parsed.kind === "profile") {
    const profile = profiles.find((p) => p.id === parsed.id);
    return profile === undefined ? {} : samplingOnlyServer(profile, effective);
  }
  if (parsed.kind === "preset") {
    const preset = presets.find((p) => p.id === parsed.id);
    return preset?.server ?? {};
  }
  return {};
}

/**
 * 弹层打开那一刻的初始选中项。
 *
 * `initialServer` 非空时直接原样使用——那是 T18 里用户在推荐卡上已经勾选
 * 好的字段集合，不再按 defaultChecked 二次筛选。它缺失时（硬刷新丢了内存
 * state，只剩 URL 上的 `?applyRecommend=<id>`）退化成「从下拉现选该
 * profile」，即按采样类默认口径重算；`profiles` 里找不到这个 id
 * （典型情形：硬刷新直接落在文件视图，README 视图从未挂载过，见档案详情页
 * 的裁定）就落回「走全局默认」，不生编造一个选项出来。
 */
export function initialParamSelection(
  profiles: readonly RecommendedProfile[],
  effective: ServerConfig,
  initialProfileId: string | undefined,
  initialServer: Partial<ServerConfig> | undefined,
): { pick: string; server: Partial<ServerConfig> } {
  if (initialServer !== undefined && Object.keys(initialServer).length > 0) {
    return {
      pick: initialProfileId !== undefined ? profilePickValue(initialProfileId) : DEFAULT_PARAM_PICK,
      server: initialServer,
    };
  }
  if (initialProfileId !== undefined) {
    const profile = profiles.find((p) => p.id === initialProfileId);
    if (profile !== undefined) {
      return { pick: profilePickValue(profile.id), server: samplingOnlyServer(profile, effective) };
    }
  }
  return { pick: DEFAULT_PARAM_PICK, server: {} };
}

const SUMMARY_INLINE_COUNT = 2;

/** 摘要 chip 文案：`temp 0.6 · top_p 0.95 · +2`。空对象返回 null——
 *  调用方据此不渲染 chip（「走全局默认」没什么好摘要的） */
export function summarizeParamServer(server: Partial<ServerConfig>): string | null {
  const entries = Object.entries(server);
  if (entries.length === 0) return null;
  const shown = entries.slice(0, SUMMARY_INLINE_COUNT).map(([key, value]) => `${key} ${String(value)}`);
  const rest = entries.length - shown.length;
  return rest > 0 ? `${shown.join(" · ")} · +${rest}` : shown.join(" · ");
}
