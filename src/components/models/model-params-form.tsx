"use client";

import { useMemo, type ReactNode } from "react";
import { RotateCcw, ChevronDown, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";

import { mergeConfig } from "@/core/config";
import type { GgufMeta } from "@/core/gguf";
import { paramHints } from "@/core/gguf-hints";
import { cacheTypeSchema, type DefaultConfig, type Overrides } from "@/core/schemas";
import {
  DEFAULT_OPTION,
  SAMPLING_KEYS,
  deriveOverrides,
  mergeForSave,
  type DraftState,
} from "@/lib/model-form";
import { PARAM_PRESET_IDS, applyPresetDraft } from "@/lib/param-presets";
import type { PickerItem } from "@/lib/model-file-picker";
import { cn } from "@/lib/utils";
import { ParamTip } from "@/components/param-tip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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

/** 表单字段外壳：标签（含 mono 参数名 + 可选 Info 提示）/ 控件 / 提示 / GGUF 越界警告 / 字段级错误红字 */
function FieldShell({
  label,
  param,
  hint,
  warn,
  tip,
  error,
  children,
  className,
}: {
  label: string;
  param?: string;
  hint?: string;
  /** 参数一句话解释（U20），Label 右侧 Info 图标 hover/focus 显示 */
  tip?: string;
  /** GGUF 元数据越界提示（U16 后半）：amber，语义比 hint 重但不阻塞保存，与 error（destructive）区分 */
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
      {hint && <p className="text-xs leading-snug text-muted-foreground">{hint}</p>}
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
  /** GGUF 头解析结果；null 表示文件缺失/未解析，越界提示整体不显示 */
  ggufMeta: GgufMeta | null;
  /** 文件选择弹层的候选项（任务 5 接入；本任务先占位不渲染） */
  pickerItems: PickerItem[];
  /** 插到基础信息卡最前的字段（克隆页的模型 id） */
  identityFields?: ReactNode;
}

export function ModelParamsForm({
  drafts,
  onSet,
  onReplace,
  fieldErrors,
  defaults,
  namespaces,
  params,
  ggufMeta,
  identityFields,
}: ModelParamsFormProps) {
  const t = useTranslations("pages.modelEdit");
  const tc = useTranslations("common");
  const tgh = useTranslations("pages.models.ggufHints");
  const { overrides, preview, overriddenKeys } = params;

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

  const samplingOverridden = SAMPLING_KEYS.filter(
    (key) => overrides.server && key in overrides.server,
  ).length;

  const cacheOptions = cacheTypeSchema.options;

  return (
    <div className="grid grid-cols-1 items-start gap-3.5 lg:grid-cols-[1.4fr_1fr]">
      {/* 左：表单 */}
      <div className="flex min-w-0 flex-col gap-3.5">
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
                hint={t("namespaceHint")}
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
                hint={t("ggufHint")}
              >
                <Input
                  className="font-mono"
                  placeholder="main/model-Q4_K_M.gguf"
                  value={drafts.ggufFile}
                  onChange={(e) => onSet("ggufFile", e.target.value)}
                  aria-invalid={!!fieldErrors.ggufFile || undefined}
                />
              </FieldShell>
            </div>
            <FieldShell
              label={t("labelMmproj")}
              param="mmproj_file"
              error={fieldErrors.mmproj}
              hint={t("mmprojHint")}
            >
              <Input
                className="font-mono"
                placeholder="—"
                value={drafts.mmproj}
                onChange={(e) => onSet("mmproj", e.target.value)}
                aria-invalid={!!fieldErrors.mmproj || undefined}
              />
            </FieldShell>
          </CardContent>
        </Card>

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
            </div>
          </CardContent>
        </Card>

        <details className="group rounded-xl bg-card ring-1 ring-foreground/10">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 px-4 py-3 text-sm font-semibold select-none [&::-webkit-details-marker]:hidden">
            <ChevronDown className="size-3.5 text-muted-foreground transition-transform group-open:rotate-90" />
            {samplingOverridden > 0
              ? t("samplingSummary", { count: samplingOverridden })
              : t("samplingSummaryNone")}
          </summary>
          <div className="grid grid-cols-1 gap-3.5 border-t px-4 py-3.5 sm:grid-cols-2">
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
        </details>
      </div>

      {/* 右：生效参数预览（sticky） */}
      <div className="min-w-0 lg:sticky lg:top-[74px]">
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
    </div>
  );
}
