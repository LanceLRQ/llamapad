/**
 * 模型表单纯逻辑（编辑页与克隆页共用）：草稿 ↔ overrides 的三态转换。
 *
 * 从 edit-form.tsx 下沉——这批函数是参数编辑最容易出错的地方
 * （override 与 default 的合并语义、空串 / null / 「未设置」的三态区分），
 * 但此前埋在 1125 行的组件文件里跟着变得不可测。
 *
 * 三态约定：
 * - 草稿全为字符串（数字也存字符串），空串 = 未覆盖（跟随默认）
 * - Select 的「跟随默认」用哨兵 DEFAULT_OPTION 表达（Base UI Select 需要
 *   非空 item value，空串在那里有歧义），落到草稿时还原为空串
 * - Switch（enable_thinking）显示的是生效值，草稿 "false" 是**有效覆盖**
 *   而非未设置——这是最容易被 `if (v)` 写塌的一处
 */

import type { ModelConfig, Overrides } from "@/core/schemas";

/** Select「跟随默认」的哨兵值（Base UI Select 需要 item value，空串易歧义） */
export const DEFAULT_OPTION = "__default";

/** 表单可编辑的 overrides 键（"section.field"）；不在此列的既有覆盖保存时保留 */
export const EDITABLE_KEYS = [
  "docker.container_name",
  "docker.host_port",
  "docker.image",
  "docker.gpu",
  "server.gpu_layers",
  "server.ctx_size",
  "server.cache_type_k",
  "server.cache_type_v",
  "server.flash_attention",
  "server.enable_thinking",
  "server.reasoning_effort",
  "server.temp",
  "server.top_p",
  "server.top_k",
  "server.min_p",
  "server.repeat_penalty",
  "server.presence_penalty",
] as const;

/** 服务端 400/409 issues[].path → 表单字段（草稿键），未映射的进顶部横幅 */
export const PATH_TO_FIELD: Record<string, string> = {
  name: "name",
  display_name: "displayName",
  namespace: "namespace",
  gguf_file: "ggufFile",
  mmproj_file: "mmproj",
  "overrides.docker.container_name": "containerName",
  "overrides.docker.host_port": "hostPort",
  "overrides.docker.image": "image",
  "overrides.docker.gpu": "gpuDevices",
  "overrides.server.gpu_layers": "gpuLayers",
  "overrides.server.ctx_size": "ctxSize",
  "overrides.server.cache_type_k": "cacheK",
  "overrides.server.cache_type_v": "cacheV",
  "overrides.server.flash_attention": "flashAttn",
  "overrides.server.enable_thinking": "thinking",
  "overrides.server.reasoning_effort": "effort",
  "overrides.server.temp": "temp",
  "overrides.server.top_p": "topP",
  "overrides.server.top_k": "topK",
  "overrides.server.min_p": "minP",
  "overrides.server.repeat_penalty": "repeatPenalty",
  "overrides.server.presence_penalty": "presencePenalty",
};

/** 表单草稿：全部为字符串（数字也存字符串，空串 = 覆盖未设置） */
export interface DraftState {
  displayName: string;
  namespace: string;
  ggufFile: string;
  mmproj: string;
  containerName: string;
  hostPort: string;
  image: string;
  gpuMode: "default" | "all" | "none" | "device";
  gpuDevices: string;
  gpuLayers: string;
  ctxSize: string;
  cacheK: string;
  cacheV: string;
  flashAttn: string;
  thinking: string;
  effort: string;
  temp: string;
  topP: string;
  topK: string;
  minP: string;
  repeatPenalty: string;
  presencePenalty: string;
}

export function toIntOrNull(s: string): number | null {
  const t = s.trim();
  if (t === "" || !/^-?\d+$/.test(t)) return null;
  return Number(t);
}

export function toFloatOrNull(s: string): number | null {
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** 初始草稿 = 已有 overrides（非合并值） */
export function initDrafts(model: ModelConfig): DraftState {
  const docker = model.overrides?.docker ?? {};
  const server = model.overrides?.server ?? {};
  const gpu = docker.gpu;
  const num = (v: number | undefined) => (v === undefined ? "" : String(v));
  return {
    displayName: model.display_name,
    namespace: model.namespace,
    ggufFile: model.gguf_file,
    mmproj: model.mmproj_file ?? "",
    containerName: docker.container_name ?? "",
    hostPort: num(docker.host_port),
    image: docker.image ?? "",
    gpuMode:
      gpu === "all" || gpu === "none" ? gpu : gpu?.startsWith("device=") ? "device" : "default",
    gpuDevices: gpu?.startsWith("device=") ? gpu.slice("device=".length) : "",
    gpuLayers: num(server.gpu_layers),
    ctxSize: num(server.ctx_size),
    cacheK: server.cache_type_k ?? "",
    cacheV: server.cache_type_v ?? "",
    flashAttn: server.flash_attention ?? "",
    thinking: server.enable_thinking === undefined ? "" : String(server.enable_thinking),
    effort: server.reasoning_effort ?? "",
    temp: num(server.temp),
    topP: num(server.top_p),
    topK: num(server.top_k),
    minP: num(server.min_p),
    repeatPenalty: num(server.repeat_penalty),
    presencePenalty: num(server.presence_penalty),
  };
}

/**
 * 克隆用的初始草稿（规格 §5）：除显示名加副本后缀外与原模型逐字一致。
 * 后缀由调用方从 i18n 取（中文「（副本）」/ 英文 " (copy)"），本函数不硬编码文案。
 */
export function initDuplicateDrafts(model: ModelConfig, displayNameSuffix: string): DraftState {
  const drafts = initDrafts(model);
  return { ...drafts, displayName: `${drafts.displayName}${displayNameSuffix}` };
}

/** 草稿 → overrides（只含表单可编辑键；非法中间态如实拼入，交给 zod 在预览里报错） */
export function deriveOverrides(d: DraftState): Overrides {
  const docker: Record<string, string | number> = {};
  if (d.containerName.trim()) docker.container_name = d.containerName.trim();
  const hostPort = toIntOrNull(d.hostPort);
  if (hostPort !== null) docker.host_port = hostPort;
  if (d.image.trim()) docker.image = d.image.trim();
  if (d.gpuMode === "all" || d.gpuMode === "none") docker.gpu = d.gpuMode;
  else if (d.gpuMode === "device") docker.gpu = `device=${d.gpuDevices.trim()}`;

  const server: Record<string, string | number | boolean> = {};
  const gpuLayers = toIntOrNull(d.gpuLayers);
  if (gpuLayers !== null) server.gpu_layers = gpuLayers;
  const ctxSize = toIntOrNull(d.ctxSize);
  if (ctxSize !== null) server.ctx_size = ctxSize;
  if (d.cacheK) server.cache_type_k = d.cacheK;
  if (d.cacheV) server.cache_type_v = d.cacheV;
  if (d.flashAttn) server.flash_attention = d.flashAttn;
  if (d.thinking) server.enable_thinking = d.thinking === "true";
  if (d.effort) server.reasoning_effort = d.effort;
  for (const [draft, key] of [
    [d.temp, "temp"],
    [d.topP, "top_p"],
    [d.minP, "min_p"],
    [d.repeatPenalty, "repeat_penalty"],
    [d.presencePenalty, "presence_penalty"],
  ] as const) {
    const v = toFloatOrNull(draft);
    if (v !== null) server[key] = v;
  }
  const topK = toIntOrNull(d.topK);
  if (topK !== null) server.top_k = topK;

  const overrides: Overrides = {};
  if (Object.keys(docker).length > 0) overrides.docker = docker as Overrides["docker"];
  if (Object.keys(server).length > 0) overrides.server = server as Overrides["server"];
  return overrides;
}

/**
 * 克隆提交体（规格 §5）：name/参数走用户填的草稿与预览态 overrides，
 * download 元数据从源模型整份透传——它记的是「这个 GGUF 从哪来」，新模板
 * 指向同一文件，来源事实不变；文件被误删后新模板仍可靠它重下。
 *
 * 源模型没有 download（手动放进 models 目录的文件）时，结果里不出现这个键，
 * 而不是键存在但值为 undefined——序列化前的这层纯函数就该给出干净的契约，
 * 单元测试也能直接断言“不存在该键”，不必依赖 JSON.stringify 抹平两者的差异。
 */
export function buildDuplicatePayload(
  name: string,
  drafts: DraftState,
  source: ModelConfig,
  overrides: Overrides,
): Record<string, unknown> {
  return {
    name: name.trim(),
    display_name: drafts.displayName.trim(),
    namespace: drafts.namespace,
    gguf_file: drafts.ggufFile.trim(),
    ...(drafts.mmproj.trim() === "" ? {} : { mmproj_file: drafts.mmproj.trim() }),
    ...(source.download === undefined ? {} : { download: source.download }),
    overrides,
  };
}

/**
 * 保存用的最终 overrides：以既有 overrides 为底，可编辑键按当前草稿增删，
 * 表单外的覆盖（如 docker.model_volume / server.batch_size）原样保留。
 */
export function mergeForSave(original: Overrides, current: Overrides): Overrides {
  const docker: Record<string, unknown> = { ...(original.docker ?? {}) };
  const server: Record<string, unknown> = { ...(original.server ?? {}) };
  for (const key of EDITABLE_KEYS) {
    const dot = key.indexOf(".");
    const sec = key.slice(0, dot) as "docker" | "server";
    const field = key.slice(dot + 1);
    const value = (current[sec] as Record<string, unknown> | undefined)?.[field];
    const target = sec === "docker" ? docker : server;
    if (value !== undefined) target[field] = value;
    else delete target[field];
  }
  const overrides: Overrides = {};
  if (Object.keys(docker).length > 0) overrides.docker = docker as Overrides["docker"];
  if (Object.keys(server).length > 0) overrides.server = server as Overrides["server"];
  return overrides;
}
