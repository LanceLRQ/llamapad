"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Loader2, RotateCcw, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";

import { mergeConfig } from "@/core/config";
import type { GgufMetaView } from "@/core/gguf";
import { paramHints } from "@/core/gguf-hints";
import { cacheTypeSchema, type DefaultConfig, type Overrides } from "@/core/schemas";
import { apiFetch } from "@/lib/api";
import { deviceIndexMap, visibleDevices } from "@/lib/gpu-visibility";
import {
  DEFAULT_OPTION,
  deriveOverrides,
  mergeForSave,
  type DraftState,
} from "@/lib/model-form";
import type { ModelFormSection } from "@/lib/model-form-sections";
import { PARAM_PRESET_IDS, applyPresetDraft } from "@/lib/param-presets";
import { draftToPresetServer, presetServerToDraftPatch } from "@/lib/preset-draft";
import { effortFieldState, effortLevelOptions, type EffortSupport } from "@/lib/reasoning-effort";
import type { PickerItem } from "@/lib/model-file-picker";
import { shouldShowSplitFields, splitHints, type SplitHint } from "@/lib/split-hints";
import { cn } from "@/lib/utils";
import { ParamTip } from "@/components/param-tip";
import { toast } from "@/components/toast-store";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { ParamPreset } from "@/server/repo/presets";
import { ModelFilePicker } from "./model-file-picker";
import { PresetPickerDialog } from "./preset-picker-dialog";

/**
 * 模型参数编辑区（编辑页与克隆页共用）。
 *
 * 为什么抽出来而不是给 EditForm 加 mode 分支（规格 §3.1）：edit-form.tsx
 * 原有 1125 行，而 running / configStale / ggufMeta / 删除区在"新建一条配置"
 * 的语境下全部无意义，加 mode 的代价是处处 if。抽开之后两边的职责说得清：
 * 一边管「改一条已存在的记录」，一边管「造一条新记录」，共用的只是
 * 「参数长什么样」。
 *
 * 身份字段（克隆页的模型 id）由调用方经 identityFields 插槽注入到基础信息卡
 * 的最前面——它只在克隆页存在，不值得为它开一个布尔开关。
 *
 * i18n 沿用 pages.modelEdit 命名空间（两个页面共用同一批标签，不为克隆页
 * 复制一份同义键）。
 *
 * 分节渲染（M16 T9 起；本批把基本信息/Docker/性能/采样四格合并回一节「配置」）：
 * `section` 决定渲染哪些卡片。`section === "config"` 时四张卡（基本信息/Docker/
 * 性能参数/采样参数）纵向依次渲染、各自保留自己的标题，不再各占一个二级栏条目；
 * 表单状态（drafts）仍整份留在父组件手上，这里只是条件渲染，切节不会丢草稿。
 * `section` 为 "danger" 时本组件不渲染任何内容——危险区是页面级别的内容
 * （编辑页专属，克隆页没有），不属于这个共用参数表单，由调用方自行渲染。
 */

/** 预览小节：一段（docker/server）逐键行，被覆盖键打 amber 角标 + 默认值删除线 */
function PreviewSection({
  section,
  label,
  defaultsObj,
  mergedObj,
  overridden,
}: {
  section: "docker" | "server";
  label: string;
  defaultsObj: DefaultConfig["docker"] | DefaultConfig["server"];
  mergedObj: DefaultConfig["docker"] | DefaultConfig["server"];
  overridden: Set<string>;
}) {
  const t = useTranslations("pages.modelEdit");
  const rows = defaultsObj as Record<string, string | number | boolean>;
  const merged = mergedObj as Record<string, string | number | boolean>;
  return (
    <div className="flex flex-col gap-1.5">
      <p className="font-mono text-[11px] font-medium tracking-[0.08em] text-muted-foreground">
        {label}
      </p>
      <dl className="flex flex-col gap-1 font-mono text-xs">
        {Object.keys(rows).map((key) => {
          const isOver = overridden.has(`${section}.${key}`);
          return (
            <div key={key} className="flex items-baseline justify-between gap-3">
              <dt className="shrink-0 text-muted-foreground">{key}</dt>
              <dd className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
                {isOver && (
                  <span className="text-muted-foreground/60 line-through">
                    {String(rows[key])}
                  </span>
                )}
                {isOver && <span aria-hidden className="text-muted-foreground/50">→</span>}
                <span className={cn(isOver && "font-medium text-amber-600 dark:text-amber-400")}>
                  {String(merged[key])}
                </span>
                {isOver && (
                  <Badge
                    variant="outline"
                    className="h-4 gap-1 border-amber-500/30 bg-amber-500/10 px-1 font-sans text-[10px] leading-none text-amber-600 dark:text-amber-400"
                  >
                    <span className="size-1 rounded-full bg-amber-500" />
                    {t("badgeOverridden")}
                  </Badge>
                )}
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

/** 表单字段外壳：标签（含 mono 参数名 + 可选 Info 提示）/ 控件 / GGUF 越界警告 / 字段级错误红字。
 * 参数解释统一走 tip（`?` 悬停，B 级），字段下方不留常驻说明行——GGUF 解析出的事实数据
 * （如「qwen2 · 28 层 · 原生上下文 131072」）是字段自身内容的一部分，直接塞进 children，不走这里。 */
function FieldShell({
  label,
  param,
  warn,
  tip,
  error,
  children,
  className,
}: {
  label: string;
  param?: string;
  /** 参数一句话解释（U20），Label 右侧 Info 图标 hover/focus 显示 */
  tip?: string;
  /** GGUF 元数据越界提示（U16 后半）：amber，语义比 tip 重但不阻塞保存，与 error（destructive）区分 */
  warn?: string;
  error?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <div className="flex items-baseline gap-1">
        <Label className="items-baseline">
          <span>{label}</span>
          {param && (
            <code className="font-mono text-[11px] font-normal text-muted-foreground">{param}</code>
          )}
        </Label>
        {tip && <ParamTip text={tip} />}
      </div>
      {children}
      {warn && (
        <p className="flex items-start gap-1 text-xs leading-snug text-amber-700 dark:text-amber-400">
          <TriangleAlert className="mt-0.5 size-3 shrink-0" />
          <span>{warn}</span>
        </p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

/** 数字输入（草稿存字符串，空串 = 跟随默认，placeholder 显示默认值） */
function NumInput({
  value,
  onChange,
  placeholder,
  invalid,
  step,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  invalid?: boolean;
  step?: string;
}) {
  return (
    <Input
      type="number"
      step={step}
      className="font-mono"
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-invalid={invalid || undefined}
    />
  );
}

/** 参数区的派生计算：最终 overrides / 生效参数预览 / 被覆盖键集合 */
export function useModelParams(baseOverrides: Overrides, drafts: DraftState, defaults: DefaultConfig) {
  /** 最终 overrides（预览与保存共用同一份，保证所见即所存） */
  const overrides = useMemo(
    () => mergeForSave(baseOverrides, deriveOverrides(drafts)),
    [baseOverrides, drafts],
  );

  const preview = useMemo(() => {
    try {
      return { merged: mergeConfig(defaults, overrides), error: null as string | null };
    } catch (error) {
      // 中间态非法（如 host_port 越界、device= 未填完）：预览回退纯默认合并 + amber 提示
      return { merged: mergeConfig(defaults, {}), error: (error as Error).message };
    }
  }, [defaults, overrides]);

  const overriddenKeys = useMemo(
    () =>
      new Set([
        ...Object.keys(overrides.docker ?? {}).map((key) => `docker.${key}`),
        ...Object.keys(overrides.server ?? {}).map((key) => `server.${key}`),
      ]),
    [overrides],
  );

  return { overrides, preview, overriddenKeys };
}

export interface ModelParamsFormProps {
  /** 只渲染这一节；"danger" 不属于本组件（危险区是调用方页面级内容），渲染为空 */
  section: ModelFormSection;
  drafts: DraftState;
  /** 单键写入（父组件负责同时清 saved 标记等副作用） */
  onSet: <K extends keyof DraftState>(key: K, value: DraftState[K]) => void;
  /** 整体替换（参数预设按钮批量改三键） */
  onReplace: (next: DraftState) => void;
  fieldErrors: Partial<Record<string, string>>;
  defaults: DefaultConfig;
  namespaces: string[];
  /** useModelParams 的返回值，父组件提交时也要用同一份 overrides */
  params: ReturnType<typeof useModelParams>;
  /** GGUF 头解析结果；null 表示文件缺失/未解析，越界提示与信息行整体不显示 */
  ggufMeta: GgufMetaView | null;
  /** 「思考强度」支持态（page.tsx 用 chatTemplate 判定过一次）：决定选择器的可选档位与禁用态 */
  effortSupport: EffortSupport;
  /** 文件选择弹层的候选项（规格 §4）：server component 扫盘装配后直接下发，
   *  不经客户端请求，router.refresh() 也能顺带刷新 */
  pickerItems: PickerItem[];
  /** 插到基础信息卡最前的字段（克隆页的模型 id） */
  identityFields?: ReactNode;
  /** 只在 section === "config" 时渲染在基础信息卡上方的一行说明（克隆页顶栏
   * 塞不下的长副题落点在这里；编辑页不传，不为了一个专属场景改分节判断逻辑） */
  basicNote?: ReactNode;
}

export function ModelParamsForm({
  section,
  drafts,
  onSet,
  onReplace,
  fieldErrors,
  defaults,
  namespaces,
  params,
  ggufMeta,
  effortSupport,
  pickerItems,
  identityFields,
  basicNote,
}: ModelParamsFormProps) {
  const t = useTranslations("pages.modelEdit");
  const tc = useTranslations("common");
  const tgh = useTranslations("pages.models.ggufHints");
  const tgi = useTranslations("pages.models.ggufInfo");
  const tsh = useTranslations("pages.models.splitHints");
  const { preview, overriddenKeys } = params;

  // 用户预设（下拉）与「另存为预设」弹层开关。预设拉不到不影响改参数本身，
  // 静默降级成「只有内置三档」——表单不因一个附属能力报错。
  const [userPresets, setUserPresets] = useState<ParamPreset[]>([]);
  const [saveOpen, setSaveOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    void apiFetch("/api/v1/presets", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { presets: ParamPreset[] } | null) => {
        if (d !== null) setUserPresets(d.presets);
      })
      .catch(() => {
        // 网络/鉴权失败都算「没有用户预设」，不弹错误
      });
  }, []);

  // 整机 GPU 列表（多卡支持批次）：deviceCount 与 visibleCount 都由它派生，
  // 避免两个 state 不同步。复用监控用的 /api/v1/gpu/stats，不新增端点；
  // 取不到就是空数组，与"探测不可用"同处理。
  const [gpuDevices, setGpuDevices] = useState<{ index: number }[]>([]);
  useEffect(() => {
    void apiFetch("/api/v1/gpu/stats", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((payload: { devices?: { index: number }[] } | null) =>
        setGpuDevices(payload?.devices ?? []),
      )
      .catch(() => setGpuDevices([]));
  }, []);

  const deviceCount = gpuDevices.length;
  // 该模型可见的卡数；探测不到时为 null，splitHints 据此跳过与卡数有关的判定
  const visibleCount =
    deviceCount > 0 ? visibleDevices(gpuDevices, preview.merged.docker.gpu).length : null;
  const indexMap = deviceIndexMap(preview.merged.docker.gpu);
  const hasSplitOverride =
    drafts.splitMode !== "" || drafts.tensorSplit !== "" || drafts.mainGpu !== "";
  const showSplit = shouldShowSplitFields({ deviceCount, hasOverride: hasSplitOverride });
  // 与 gguf 越界提示同理：用生效值而非草稿——草稿是「想覆盖成什么」，
  // 生效值才是真正会传给 llama-server 的那个
  const splitWarnings = useMemo(
    () =>
      splitHints({
        splitMode: preview.merged.server.split_mode,
        tensorSplit: preview.merged.server.tensor_split,
        mainGpu: preview.merged.server.main_gpu,
        cacheK: preview.merged.server.cache_type_k,
        cacheV: preview.merged.server.cache_type_v,
        flashAttention: preview.merged.server.flash_attention,
        visibleCount,
      }),
    [preview, visibleCount],
  );
  const hintFor = (field: SplitHint["field"]) => {
    const hit = splitWarnings.find((h) => h.field === field);
    return hit ? tsh(hit.code, hit.values) : undefined;
  };
  const splitModeLabel = (mode: string) =>
    mode === "none"
      ? t("splitModeOptionNone")
      : mode === "layer"
        ? t("splitModeOptionLayer")
        : mode === "tensor"
          ? t("splitModeOptionTensor")
          : t("splitModeOptionRow");

  // GGUF 越界提示（U16 后半）：用最终生效值判定，而非草稿——草稿是"想覆盖成什么"，
  // 生效值才是实际会传给 llama-server 的参数
  const ggufHints = useMemo(
    () =>
      ggufMeta
        ? paramHints(ggufMeta, {
            gpu_layers: preview.merged.server.gpu_layers,
            ctx_size: preview.merged.server.ctx_size,
          })
        : [],
    [ggufMeta, preview],
  );
  const gpuLayersHint = ggufHints.find((h) => h.field === "gpu_layers");
  const ctxSizeHint = ggufHints.find((h) => h.field === "ctx_size");

  const cacheOptions = cacheTypeSchema.options;

  // 「思考强度」选择器的禁用态与提示文案：三态判定下沉到 lib/reasoning-effort.ts，
  // 这里只按 note code 映射 i18n key（enable_thinking 用生效值而非草稿——与上面
  // gguf 越界提示同理，草稿是"想覆盖成什么"，生效值才是真正会传给 llama-server 的那个）
  const effortState = effortFieldState(effortSupport, preview.merged.server.enable_thinking);
  const effortNote =
    effortState.note === "thinkingOff"
      ? t("effortNoteThinkingOff")
      : effortState.note === "unsupported"
        ? t("effortNoteUnsupported")
        : effortState.note === "unknown"
          ? t("effortNoteUnknown")
          : effortState.note === "levelsUnknown"
            ? t("effortNoteLevelsUnknown")
            : undefined;

  return (
    <>
      {section === "config" && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-3.5">
            {basicNote}
            <Card>
              <CardContent className="flex flex-col gap-3.5">
                <h2 className="text-sm font-semibold">{t("basicSection")}</h2>
                {identityFields}
                <FieldShell label={t("labelDisplayName")} error={fieldErrors.displayName}>
                  <Input
                    value={drafts.displayName}
                    onChange={(e) => onSet("displayName", e.target.value)}
                    aria-invalid={!!fieldErrors.displayName || undefined}
                    required
                  />
                </FieldShell>
                <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
                  <FieldShell
                    label={t("labelNamespace")}
                    error={fieldErrors.namespace}
                    tip={t("namespaceHint")}
                  >
                    <Select
                      value={drafts.namespace}
                      onValueChange={(v) => onSet("namespace", String(v))}
                    >
                      <SelectTrigger className="w-full" aria-invalid={!!fieldErrors.namespace}>
                        <SelectValue>{(v: string | null) => String(v ?? "")}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {namespaces.map((ns) => (
                          <SelectItem key={ns} value={ns}>
                            {ns}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FieldShell>
                  <FieldShell
                    label={t("labelGguf")}
                    param="gguf_file"
                    error={fieldErrors.ggufFile}
                    tip={t("ggufHint")}
                  >
                    <div className="flex items-center gap-1.5">
                      <Input
                        className="font-mono"
                        placeholder="main/model-Q4_K_M.gguf"
                        value={drafts.ggufFile}
                        onChange={(e) => onSet("ggufFile", e.target.value)}
                        aria-invalid={!!fieldErrors.ggufFile || undefined}
                      />
                      <ModelFilePicker
                        items={pickerItems}
                        field="gguf"
                        onSelect={(v) => onSet("ggufFile", v)}
                      />
                    </div>
                    {/* GGUF 头解析出的事实数据，不算 B 级说明——常驻显示，不收进悬停 */}
                    {ggufMeta &&
                      ggufMeta.architecture !== null &&
                      ggufMeta.blockCount !== null &&
                      ggufMeta.contextLength !== null && (
                        <p className="font-mono text-xs text-muted-foreground">
                          {tgi("line", {
                            arch: ggufMeta.architecture,
                            blocks: ggufMeta.blockCount,
                            ctx: ggufMeta.contextLength,
                          })}
                        </p>
                      )}
                  </FieldShell>
                </div>
                <FieldShell
                  label={t("labelMmproj")}
                  param="mmproj_file"
                  error={fieldErrors.mmproj}
                  tip={t("mmprojHint")}
                >
                  <div className="flex items-center gap-1.5">
                    <Input
                      className="font-mono"
                      placeholder="—"
                      value={drafts.mmproj}
                      onChange={(e) => onSet("mmproj", e.target.value)}
                      aria-invalid={!!fieldErrors.mmproj || undefined}
                    />
                    <ModelFilePicker
                      items={pickerItems}
                      field="mmproj"
                      onSelect={(v) => onSet("mmproj", v)}
                    />
                  </div>
                </FieldShell>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardContent className="flex flex-col gap-3.5">
              <div className="flex items-baseline gap-2">
                <h2 className="text-sm font-semibold">{t("dockerSection")}</h2>
                <code className="font-mono text-[11px] text-muted-foreground">
                  overrides.docker
                </code>
              </div>
              <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
                <FieldShell
                  label={t("labelContainerName")} tip={tc("paramHints.container_name")}
                  param="container_name"
                  error={fieldErrors.containerName}
                >
                  <Input
                    className="font-mono"
                    placeholder={defaults.docker.container_name}
                    value={drafts.containerName}
                    onChange={(e) => onSet("containerName", e.target.value)}
                    aria-invalid={!!fieldErrors.containerName || undefined}
                  />
                </FieldShell>
                <FieldShell
                  label={t("labelHostPort")} tip={tc("paramHints.host_port")}
                  param="host_port"
                  error={fieldErrors.hostPort}
                >
                  <NumInput
                    value={drafts.hostPort}
                    onChange={(v) => onSet("hostPort", v)}
                    placeholder={String(defaults.docker.host_port)}
                    invalid={!!fieldErrors.hostPort}
                    step="1"
                  />
                </FieldShell>
                <FieldShell label={t("labelImage")} tip={tc("paramHints.image")} param="image" error={fieldErrors.image}>
                  <Input
                    className="font-mono"
                    placeholder={defaults.docker.image}
                    value={drafts.image}
                    onChange={(e) => onSet("image", e.target.value)}
                    aria-invalid={!!fieldErrors.image || undefined}
                  />
                </FieldShell>
                <FieldShell label={t("labelGpu")} tip={tc("paramHints.gpu")} param="gpu" error={fieldErrors.gpuDevices}>
                  <Select
                    value={drafts.gpuMode === "default" ? DEFAULT_OPTION : drafts.gpuMode}
                    onValueChange={(v) =>
                      onSet(
                        "gpuMode",
                        v === DEFAULT_OPTION ? "default" : (v as DraftState["gpuMode"]),
                      )
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue>
                        {(v: string) =>
                          v === DEFAULT_OPTION
                            ? t("followDefaultValue", { value: defaults.docker.gpu })
                            : v === "all"
                              ? t("gpuOptionAll")
                              : v === "none"
                                ? t("gpuOptionNone")
                                : t("gpuOptionDevice")
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={DEFAULT_OPTION}>
                        {t("followDefaultValue", { value: defaults.docker.gpu })}
                      </SelectItem>
                      <SelectItem value="all">{t("gpuOptionAll")}</SelectItem>
                      <SelectItem value="none">{t("gpuOptionNone")}</SelectItem>
                      <SelectItem value="device">{t("gpuOptionDevice")}</SelectItem>
                    </SelectContent>
                  </Select>
                  {drafts.gpuMode === "device" && (
                    <Input
                      className="mt-1.5 font-mono"
                      placeholder={t("gpuDevicePlaceholder")}
                      value={drafts.gpuDevices}
                      onChange={(e) => onSet("gpuDevices", e.target.value)}
                      aria-invalid={!!fieldErrors.gpuDevices || undefined}
                    />
                  )}
                </FieldShell>
                {showSplit && (
                  <>
                    {indexMap !== null && (
                      <p className="col-span-full text-[11px] text-muted-foreground">
                        {tsh("deviceIndexNote", {
                          mapping: indexMap.map((host, i) => `${i} → GPU${host}`).join("、"),
                        })}
                      </p>
                    )}
                    <FieldShell
                      label={t("labelSplitMode")}
                      tip={tc("paramHints.split_mode")}
                      param="split_mode"
                      warn={hintFor("split_mode")}
                      error={fieldErrors.splitMode}
                    >
                      <Select
                        value={drafts.splitMode === "" ? DEFAULT_OPTION : drafts.splitMode}
                        onValueChange={(v) =>
                          onSet("splitMode", v === DEFAULT_OPTION ? "" : String(v))
                        }
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue>
                            {(v: string) =>
                              v === DEFAULT_OPTION
                                ? t("followDefaultValue", { value: "llama.cpp" })
                                : splitModeLabel(v)
                            }
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={DEFAULT_OPTION}>
                            {t("followDefaultValue", { value: "llama.cpp" })}
                          </SelectItem>
                          <SelectItem value="none">{t("splitModeOptionNone")}</SelectItem>
                          <SelectItem value="layer">{t("splitModeOptionLayer")}</SelectItem>
                          <SelectItem value="tensor">{t("splitModeOptionTensor")}</SelectItem>
                          <SelectItem value="row">{t("splitModeOptionRow")}</SelectItem>
                        </SelectContent>
                      </Select>
                    </FieldShell>
                    <FieldShell
                      label={t("labelTensorSplit")}
                      tip={tc("paramHints.tensor_split")}
                      param="tensor_split"
                      warn={hintFor("tensor_split")}
                      error={fieldErrors.tensorSplit}
                    >
                      <Input
                        className="font-mono"
                        placeholder={t("tensorSplitPlaceholder")}
                        value={drafts.tensorSplit}
                        onChange={(e) => onSet("tensorSplit", e.target.value)}
                        aria-invalid={!!fieldErrors.tensorSplit || undefined}
                      />
                    </FieldShell>
                    <FieldShell
                      label={t("labelMainGpu")}
                      tip={tc("paramHints.main_gpu")}
                      param="main_gpu"
                      warn={hintFor("main_gpu")}
                      error={fieldErrors.mainGpu}
                    >
                      <NumInput
                        value={drafts.mainGpu}
                        onChange={(v) => onSet("mainGpu", v)}
                        placeholder={t("mainGpuPlaceholder")}
                        invalid={!!fieldErrors.mainGpu}
                        step="1"
                      />
                    </FieldShell>
                  </>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="flex flex-col gap-3.5">
              <div className="flex flex-wrap items-baseline gap-2">
                <h2 className="text-sm font-semibold">{t("perfSection")}</h2>
                <code className="font-mono text-[11px] text-muted-foreground">
                  overrides.server
                </code>
                <span className="ml-auto flex items-center gap-1.5">
                  <span className="text-[11px] text-muted-foreground">
                    {tc("paramPresets.title")}
                  </span>
                  {PARAM_PRESET_IDS.map((id) => (
                    <Button
                      key={id}
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      title={tc(`paramPresets.${id}Hint`)}
                      onClick={() => onReplace(applyPresetDraft(drafts, id))}
                    >
                      {tc(`paramPresets.${id}`)}
                    </Button>
                  ))}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => setPickerOpen(true)}
                  >
                    {tc("paramPresets.userOpen")}
                    {userPresets.length > 0 && (
                      <Badge variant="secondary" className="ml-1.5 px-1 font-normal">
                        {userPresets.length}
                      </Badge>
                    )}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => setSaveOpen(true)}
                  >
                    {tc("paramPresets.saveAs")}
                  </Button>
                </span>
              </div>
              <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
                <FieldShell
                  label={t("labelGpuLayers")} tip={tc("paramHints.gpu_layers")}
                  param="gpu_layers"
                  error={fieldErrors.gpuLayers}
                  warn={gpuLayersHint ? tgh(gpuLayersHint.code, gpuLayersHint.values) : undefined}
                >
                  <NumInput
                    value={drafts.gpuLayers}
                    onChange={(v) => onSet("gpuLayers", v)}
                    placeholder={String(defaults.server.gpu_layers)}
                    invalid={!!fieldErrors.gpuLayers}
                    step="1"
                  />
                </FieldShell>
                <FieldShell
                  label={t("labelCtxSize")} tip={tc("paramHints.ctx_size")}
                  param="ctx_size"
                  error={fieldErrors.ctxSize}
                  warn={ctxSizeHint ? tgh(ctxSizeHint.code, ctxSizeHint.values) : undefined}
                >
                  <NumInput
                    value={drafts.ctxSize}
                    onChange={(v) => onSet("ctxSize", v)}
                    placeholder={String(defaults.server.ctx_size)}
                    invalid={!!fieldErrors.ctxSize}
                    step="1"
                  />
                </FieldShell>
                <FieldShell
                  label={t("labelCacheK")} tip={tc("paramHints.cache_type_k")}
                  param="cache_type_k"
                  error={fieldErrors.cacheK}
                >
                  <Select
                    value={drafts.cacheK === "" ? DEFAULT_OPTION : drafts.cacheK}
                    onValueChange={(v) => onSet("cacheK", v === DEFAULT_OPTION ? "" : String(v))}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue>
                        {(v: string) =>
                          v === DEFAULT_OPTION
                            ? t("followDefaultValue", { value: defaults.server.cache_type_k })
                            : v
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={DEFAULT_OPTION}>
                        {t("followDefaultValue", { value: defaults.server.cache_type_k })}
                      </SelectItem>
                      {cacheOptions.map((opt) => (
                        <SelectItem key={opt} value={opt}>
                          {opt}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FieldShell>
                <FieldShell
                  label={t("labelCacheV")} tip={tc("paramHints.cache_type_v")}
                  param="cache_type_v"
                  error={fieldErrors.cacheV}
                >
                  <Select
                    value={drafts.cacheV === "" ? DEFAULT_OPTION : drafts.cacheV}
                    onValueChange={(v) => onSet("cacheV", v === DEFAULT_OPTION ? "" : String(v))}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue>
                        {(v: string) =>
                          v === DEFAULT_OPTION
                            ? t("followDefaultValue", { value: defaults.server.cache_type_v })
                            : v
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={DEFAULT_OPTION}>
                        {t("followDefaultValue", { value: defaults.server.cache_type_v })}
                      </SelectItem>
                      {cacheOptions.map((opt) => (
                        <SelectItem key={opt} value={opt}>
                          {opt}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FieldShell>
                <FieldShell
                  label={t("labelFlashAttn")} tip={tc("paramHints.flash_attention")}
                  param="flash_attention"
                  error={fieldErrors.flashAttn}
                >
                  <Select
                    value={drafts.flashAttn === "" ? DEFAULT_OPTION : drafts.flashAttn}
                    onValueChange={(v) =>
                      onSet("flashAttn", v === DEFAULT_OPTION ? "" : String(v))
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue>
                        {(v: string) =>
                          v === DEFAULT_OPTION
                            ? t("followDefaultValue", { value: defaults.server.flash_attention })
                            : v
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={DEFAULT_OPTION}>
                        {t("followDefaultValue", { value: defaults.server.flash_attention })}
                      </SelectItem>
                      <SelectItem value="on">on</SelectItem>
                      <SelectItem value="off">off</SelectItem>
                    </SelectContent>
                  </Select>
                </FieldShell>
                <FieldShell
                  label={t("labelThinking")} tip={tc("paramHints.enable_thinking")}
                  param="enable_thinking"
                  error={fieldErrors.thinking}
                >
                  <div className="flex h-8 items-center gap-2.5">
                    <Switch
                      checked={preview.merged.server.enable_thinking}
                      onCheckedChange={(v) => onSet("thinking", String(v))}
                    />
                    {overriddenKeys.has("server.enable_thinking") ? (
                      <button
                        type="button"
                        onClick={() => onSet("thinking", "")}
                        title={t("resetOverride")}
                        aria-label={t("resetOverride")}
                        className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      >
                        <RotateCcw className="size-3.5" />
                      </button>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        {t("followDefaultValue", {
                          value: String(defaults.server.enable_thinking),
                        })}
                      </span>
                    )}
                  </div>
                </FieldShell>
                <FieldShell
                  label={t("labelReasoningEffort")} tip={tc("paramHints.reasoning_effort")}
                  param="reasoning_effort"
                  error={fieldErrors.effort}
                  warn={effortNote}
                >
                  <Select
                    value={drafts.effort === "" ? DEFAULT_OPTION : drafts.effort}
                    onValueChange={(v) => onSet("effort", v === DEFAULT_OPTION ? "" : String(v))}
                  >
                    <SelectTrigger className="w-full" disabled={effortState.disabled}>
                      <SelectValue>
                        {(v: string) =>
                          v === DEFAULT_OPTION
                            ? t("followDefaultValue", { value: defaults.server.reasoning_effort })
                            : v === "inherit"
                              ? t("effortInheritOption")
                              : v
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={DEFAULT_OPTION}>
                        {t("followDefaultValue", { value: defaults.server.reasoning_effort })}
                      </SelectItem>
                      <SelectItem value="inherit">{t("effortInheritOption")}</SelectItem>
                      {effortLevelOptions(effortSupport).map((level) => (
                        <SelectItem key={level} value={level}>
                          {level}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FieldShell>
              </div>
            </CardContent>
          </Card>

          <SavePresetDialog
            open={saveOpen}
            onOpenChange={setSaveOpen}
            drafts={drafts}
            onSaved={(p) =>
              setUserPresets((prev) => [...prev, p].sort((a, b) => a.name.localeCompare(b.name)))
            }
          />

          <PresetPickerDialog
            open={pickerOpen}
            onOpenChange={setPickerOpen}
            presets={userPresets}
            // 只补丁式覆盖预设里写了的键，未覆盖项保持原样（与内置三档同一条路径）
            onApply={(p) => onReplace({ ...drafts, ...presetServerToDraftPatch(p.server) })}
            onDeleted={(id) => setUserPresets((prev) => prev.filter((p) => p.id !== id))}
          />

          <Card>
            <CardContent className="flex flex-col gap-3.5">
              <h2 className="text-sm font-semibold">{t("samplingSection")}</h2>
              <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
                <FieldShell label={t("labelTemp")} tip={tc("paramHints.temp")} param="temp" error={fieldErrors.temp}>
                  <NumInput
                    value={drafts.temp}
                    onChange={(v) => onSet("temp", v)}
                    placeholder={String(defaults.server.temp)}
                    invalid={!!fieldErrors.temp}
                    step="any"
                  />
                </FieldShell>
                <FieldShell label={t("labelTopP")} tip={tc("paramHints.top_p")} param="top_p" error={fieldErrors.topP}>
                  <NumInput
                    value={drafts.topP}
                    onChange={(v) => onSet("topP", v)}
                    placeholder={String(defaults.server.top_p)}
                    invalid={!!fieldErrors.topP}
                    step="any"
                  />
                </FieldShell>
                <FieldShell label={t("labelTopK")} tip={tc("paramHints.top_k")} param="top_k" error={fieldErrors.topK}>
                  <NumInput
                    value={drafts.topK}
                    onChange={(v) => onSet("topK", v)}
                    placeholder={String(defaults.server.top_k)}
                    invalid={!!fieldErrors.topK}
                    step="1"
                  />
                </FieldShell>
                <FieldShell label={t("labelMinP")} tip={tc("paramHints.min_p")} param="min_p" error={fieldErrors.minP}>
                  <NumInput
                    value={drafts.minP}
                    onChange={(v) => onSet("minP", v)}
                    placeholder={String(defaults.server.min_p)}
                    invalid={!!fieldErrors.minP}
                    step="any"
                  />
                </FieldShell>
                <FieldShell
                  label={t("labelRepeatPenalty")} tip={tc("paramHints.repeat_penalty")}
                  param="repeat_penalty"
                  error={fieldErrors.repeatPenalty}
                >
                  <NumInput
                    value={drafts.repeatPenalty}
                    onChange={(v) => onSet("repeatPenalty", v)}
                    placeholder={String(defaults.server.repeat_penalty)}
                    invalid={!!fieldErrors.repeatPenalty}
                    step="any"
                  />
                </FieldShell>
                <FieldShell
                  label={t("labelPresencePenalty")} tip={tc("paramHints.presence_penalty")}
                  param="presence_penalty"
                  error={fieldErrors.presencePenalty}
                >
                  <NumInput
                    value={drafts.presencePenalty}
                    onChange={(v) => onSet("presencePenalty", v)}
                    placeholder={String(defaults.server.presence_penalty)}
                    invalid={!!fieldErrors.presencePenalty}
                    step="any"
                  />
                </FieldShell>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {section === "preview" && (
        <div className="flex flex-col gap-3.5">
          <Card>
            <CardContent className="flex flex-col gap-3">
              <div className="flex flex-col gap-0.5">
                <h2 className="text-sm font-semibold">{t("previewTitle")}</h2>
                <p className="text-xs text-muted-foreground">{t("previewSubtitle")}</p>
              </div>
              {preview.error && (
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-700 dark:text-amber-400"
                >
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                  <span className="min-w-0 break-words">
                    {t("previewInvalid", { message: preview.error })}
                  </span>
                </div>
              )}
              <PreviewSection
                section="docker"
                label="DOCKER"
                defaultsObj={defaults.docker}
                mergedObj={preview.merged.docker}
                overridden={overriddenKeys}
              />
              <div className="border-t" />
              <PreviewSection
                section="server"
                label="SERVER"
                defaultsObj={defaults.server}
                mergedObj={preview.merged.server}
                overridden={overriddenKeys}
              />
              <p className="rounded-lg bg-muted/50 px-2.5 py-2 text-xs text-muted-foreground">
                {t("previewSummary", { count: overriddenKeys.size })}
              </p>
            </CardContent>
          </Card>
        </div>
      )}
    </>
  );
}

/** 「另存为预设」弹层：把当前草稿里已覆盖的 server 键存成一条用户预设。
 * 只服务上面这一处，且不含可测判定，不单开文件。 */
function SavePresetDialog({
  open,
  onOpenChange,
  drafts,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  drafts: DraftState;
  onSaved: (preset: ParamPreset) => void;
}) {
  const tc = useTranslations("common");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const server = draftToPresetServer(drafts);
  const fieldCount = Object.keys(server).length;

  async function onSubmit(): Promise<void> {
    if (busy || name.trim() === "" || fieldCount === 0) return;
    setBusy(true);
    const res = await apiFetch("/api/v1/presets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: name.trim(), server, source: "model" }),
    }).catch(() => null);
    setBusy(false);

    if (res === null) return void toast.error(tc("paramPresets.errorNetwork"));
    if (res.status === 409) return void toast.error(tc("paramPresets.saveConflict"));
    if (!res.ok) return void toast.error(tc("paramPresets.errorRequest"));

    onSaved((await res.json()) as ParamPreset);
    setName("");
    onOpenChange(false);
    toast.success(tc("paramPresets.saveDone"));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{tc("paramPresets.saveAs")}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={tc("paramPresets.namePlaceholder")}
            maxLength={64}
          />
          {/* 明确告诉用户会存下哪几项——「另存」最怕存下来的和以为的不是一回事 */}
          <p className="text-xs text-muted-foreground">
            {tc("paramPresets.saveHint", { count: fieldCount })}
          </p>
        </div>
        <DialogFooter>
          <Button disabled={busy || name.trim() === "" || fieldCount === 0} onClick={() => void onSubmit()}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {tc("paramPresets.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
