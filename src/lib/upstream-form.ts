import type { UpstreamView } from "./upstream-types";
import { normalizeUpstreamBaseUrl, upstreamNameProblem } from "./upstream-url";

/**
 * 外部上游表单的草稿与请求体构造（纯函数，弹窗组件只负责渲染与发请求）。
 *
 * 密钥在编辑时的三种意图要分清：输入框留空 = 不改（服务端也不会把已保存的明文发回来）；
 * 输入了新值 = 替换；勾了「清除密钥」= 清除。
 */

export interface UpstreamDraft {
  name: string;
  displayName: string;
  baseUrl: string;
  /** 新建时是要保存的密钥；编辑时是「新密钥」，留空表示不改 */
  apiKey: string;
  /** 仅编辑时有意义 */
  clearApiKey: boolean;
  upstreamModel: string;
  note: string;
}

export type DraftMode = "create" | "edit";

export function emptyDraft(): UpstreamDraft {
  return { name: "", displayName: "", baseUrl: "", apiKey: "", clearApiKey: false, upstreamModel: "", note: "" };
}

export function draftFromView(view: UpstreamView): UpstreamDraft {
  return {
    name: view.name,
    displayName: view.displayName,
    baseUrl: view.baseUrl,
    apiKey: "",
    clearApiKey: false,
    upstreamModel: view.upstreamModel ?? "",
    note: view.note ?? "",
  };
}

export type DraftProblem = "name" | "nameReserved" | "displayName" | "baseUrl";

/** 第一个有问题的字段；都合法返回 null。服务端仍会再校验一遍，这里只为了即时提示 */
export function draftProblem(draft: UpstreamDraft, mode: DraftMode): DraftProblem | null {
  if (mode === "create") {
    const problem = upstreamNameProblem(draft.name);
    if (problem === "format") return "name";
    if (problem === "reserved") return "nameReserved";
  }
  if (draft.displayName.trim() === "") return "displayName";
  if (!normalizeUpstreamBaseUrl(draft.baseUrl).ok) return "baseUrl";
  return null;
}

export function buildCreateBody(draft: UpstreamDraft): Record<string, string> {
  const body: Record<string, string> = {
    name: draft.name,
    displayName: draft.displayName.trim(),
    baseUrl: draft.baseUrl.trim(),
  };
  if (draft.apiKey.trim() !== "") body.apiKey = draft.apiKey.trim();
  if (draft.upstreamModel.trim() !== "") body.upstreamModel = draft.upstreamModel.trim();
  if (draft.note.trim() !== "") body.note = draft.note.trim();
  return body;
}

export function buildUpdateBody(draft: UpstreamDraft): Record<string, string | null> {
  const body: Record<string, string | null> = {
    displayName: draft.displayName.trim(),
    baseUrl: draft.baseUrl.trim(),
    upstreamModel: draft.upstreamModel.trim() === "" ? null : draft.upstreamModel.trim(),
    note: draft.note.trim() === "" ? null : draft.note.trim(),
  };
  if (draft.clearApiKey) body.apiKey = "";
  else if (draft.apiKey.trim() !== "") body.apiKey = draft.apiKey.trim();
  return body;
}

/** POST /api/v1/upstreams/test 的请求体（保存前验证） */
export function buildTestBody(draft: UpstreamDraft, mode: DraftMode): Record<string, string | null> {
  const baseUrl = draft.baseUrl.trim();
  if (draft.apiKey.trim() !== "") return { baseUrl, apiKey: draft.apiKey.trim() };
  if (mode === "edit" && !draft.clearApiKey) return { baseUrl, name: draft.name };
  return { baseUrl, apiKey: null };
}
