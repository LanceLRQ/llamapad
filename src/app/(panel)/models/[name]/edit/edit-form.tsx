"use client";

import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ChevronDown, Loader2, RotateCcw, Trash2, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";

import { mergeConfig } from "@/core/config";
import { cacheTypeSchema, type DefaultConfig, type Overrides } from "@/core/schemas";
import type { StoredModel } from "@/server/repo/models";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
import { cn } from "@/lib/utils";
import { apiFetch } from "@/lib/api";

/**
 * 模型编辑表单（M1 Task 8，client）
 *
 * overrides 三态编辑方案：
 * - 表单初始值 = 模型已有 overrides（非合并值）；受控 state 保存字符串草稿
 * - 文本/数字 Input：空串 = 未覆盖（placeholder 显示默认值），有值 = 覆盖
 * - Select：额外提供「跟随默认」选项（sentinel __default ↔ 草稿空串）
 * - Switch（enable_thinking）：显示生效值；拨动即写入覆盖，出现 ↺ 按钮可清除
 * - 保存时把草稿拼回 Overrides：表单未覆盖的可编辑键从最终结果中删除，
 *   表单外的既有覆盖（model_volume / batch_size 等经 API 写入的）原样保留
 *
 * 右侧生效参数预览：客户端 import @/core/config 纯函数实时重算
 * mergeConfig(defaults, overrides)；overrides 校验失败时预览回退为纯默认合并
 * 并以 amber 横幅给出 zod 的字段路径错误（与保存时 400 issues 同源）。
 */

/** Select「跟随默认」的哨兵值（Base UI Select 需要 item value，空串易歧义） */
const DEFAULT_OPTION = "__default";

/** 表单可编辑的 overrides 键（"section.field"）；不在此列的既有覆盖保存时保留 */
const EDITABLE_KEYS = [
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
  "server.temp",
  "server.top_p",
  "server.top_k",
  "server.min_p",
  "server.repeat_penalty",
  "server.presence_penalty",
] as const;

/** 服务端 400 issues[].path → 表单字段（草稿键），未映射的进顶部横幅 */
const PATH_TO_FIELD: Record<string, string> = {
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
  "overrides.server.temp": "temp",
  "overrides.server.top_p": "topP",
  "overrides.server.top_k": "topK",
  "overrides.server.min_p": "minP",
  "overrides.server.repeat_penalty": "repeatPenalty",
  "overrides.server.presence_penalty": "presencePenalty",
};

const SAMPLING_KEYS = ["temp", "top_p", "top_k", "min_p", "repeat_penalty", "presence_penalty"];

/** 表单草稿：全部为字符串（数字也存字符串，空串 = 覆盖未设置） */
interface DraftState {
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
  temp: string;
  topP: string;
  topK: string;
  minP: string;
  repeatPenalty: string;
  presencePenalty: string;
}

function toIntOrNull(s: string): number | null {
  const t = s.trim();
  if (t === "" || !/^-?\d+$/.test(t)) return null;
  return Number(t);
}

function toFloatOrNull(s: string): number | null {
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** 初始草稿 = 已有 overrides（非合并值） */
function initDrafts(model: StoredModel): DraftState {
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
    temp: num(server.temp),
    topP: num(server.top_p),
    topK: num(server.top_k),
    minP: num(server.min_p),
    repeatPenalty: num(server.repeat_penalty),
    presencePenalty: num(server.presence_penalty),
  };
}

/** 草稿 → overrides（只含表单可编辑键；非法中间态如实拼入，交给 zod 在预览里报错） */
function deriveOverrides(d: DraftState): Overrides {
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
 * 保存用的最终 overrides：以既有 overrides 为底，可编辑键按当前草稿增删，
 * 表单外的覆盖（如 docker.model_volume / server.batch_size）原样保留。
 */
function mergeForSave(original: Overrides, current: Overrides): Overrides {
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

/** 表单字段外壳：标签（含 mono 参数名）/ 控件 / 提示 / 字段级错误红字 */
function FieldShell({
  label,
  param,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  param?: string;
  hint?: string;
  error?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <Label className="items-baseline">
        <span>{label}</span>
        {param && (
          <code className="font-mono text-[11px] font-normal text-muted-foreground">{param}</code>
        )}
      </Label>
      {children}
      {hint && <p className="text-xs leading-snug text-muted-foreground">{hint}</p>}
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

export function EditForm({
  model,
  defaults,
  namespaces,
}: {
  model: StoredModel;
  defaults: DefaultConfig;
  namespaces: string[];
}) {
  const t = useTranslations("pages.modelEdit");
  const router = useRouter();
  const [drafts, setDrafts] = useState<DraftState>(() => initDrafts(model));
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<string, string>>>({});
  const [banner, setBanner] = useState<{ kind: "error" | "conflict"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  function set<K extends keyof DraftState>(key: K, value: DraftState[K]) {
    setDrafts((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  }

  /** 最终 overrides（预览与保存共用同一份，保证所见即所存） */
  const overrides = useMemo(
    () => mergeForSave(model.overrides ?? {}, deriveOverrides(drafts)),
    [model, drafts],
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

  const samplingOverridden = SAMPLING_KEYS.filter(
    (key) => overrides.server && key in overrides.server,
  ).length;

  async function onSave(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setBanner(null);
    setFieldErrors({});
    const res = await apiFetch(`/api/v1/models/${model.name}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        display_name: drafts.displayName.trim(),
        namespace: drafts.namespace,
        gguf_file: drafts.ggufFile.trim(),
        mmproj_file: drafts.mmproj.trim() === "" ? null : drafts.mmproj.trim(),
        overrides,
      }),
    }).catch(() => null);

    if (!res) {
      setBanner({ kind: "error", text: t("errorNetwork") });
    } else if (res.ok) {
      setSaved(true);
      router.refresh();
    } else if (res.status === 400) {
      const body = (await res.json().catch(() => null)) as {
        issues?: { path: string; message: string }[];
        error?: string;
      } | null;
      const issues = body?.issues ?? [];
      if (issues.length > 0) {
        const next: Partial<Record<string, string>> = {};
        const unmapped: string[] = [];
        for (const issue of issues) {
          const field = PATH_TO_FIELD[issue.path];
          if (field) next[field] = issue.message;
          else unmapped.push(`${issue.path}: ${issue.message}`);
        }
        setFieldErrors(next);
        if (unmapped.length > 0) setBanner({ kind: "error", text: unmapped.join("; ") });
      } else {
        setBanner({ kind: "error", text: body?.error ?? t("errorRequest") });
      }
    } else if (res.status === 409) {
      setBanner({ kind: "conflict", text: t("errorConflict") });
    } else if (res.status === 404) {
      setBanner({ kind: "error", text: t("errorNotFound") });
    } else {
      setBanner({ kind: "error", text: t("errorRequest") });
    }
    setSaving(false);
  }

  function onDiscard() {
    setDrafts(initDrafts(model));
    setFieldErrors({});
    setBanner(null);
    setSaved(false);
  }

  async function onDelete() {
    setDeleting(true);
    const res = await apiFetch(`/api/v1/models/${model.name}`, { method: "DELETE" }).catch(() => null);
    if (res?.ok || res?.status === 404) {
      router.push("/models");
      return;
    }
    setDeleteOpen(false);
    if (res?.status === 409) setBanner({ kind: "conflict", text: t("errorConflict") });
    else setBanner({ kind: "error", text: res ? t("errorRequest") : t("errorNetwork") });
    setDeleting(false);
  }

  const cacheOptions = cacheTypeSchema.options;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2.5 w-fit text-muted-foreground"
          render={<Link href="/models" />}
        >
          <ArrowLeft className="size-3.5" />
          {t("backToList")}
        </Button>
        <div className="flex items-baseline gap-2.5">
          <h1 className="text-base font-semibold tracking-tight">{t("title")}</h1>
          <span className="font-mono text-sm text-muted-foreground">{model.name}</span>
        </div>
      </div>

      {banner && (
        <div
          role="alert"
          className={cn(
            "flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm",
            banner.kind === "conflict"
              ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400"
              : "border-destructive/30 bg-destructive/10 text-destructive",
          )}
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 break-words">{banner.text}</span>
        </div>
      )}

      <form onSubmit={onSave} noValidate>
        <div className="grid grid-cols-1 items-start gap-3.5 lg:grid-cols-[1.4fr_1fr]">
          {/* 左：表单 */}
          <div className="flex min-w-0 flex-col gap-3.5">
            <Card>
              <CardContent className="flex flex-col gap-3.5">
                <h2 className="text-sm font-semibold">{t("basicSection")}</h2>
                <FieldShell label={t("labelDisplayName")} error={fieldErrors.displayName}>
                  <Input
                    value={drafts.displayName}
                    onChange={(e) => set("displayName", e.target.value)}
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
                      onValueChange={(v) => set("namespace", String(v))}
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
                      onChange={(e) => set("ggufFile", e.target.value)}
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
                    onChange={(e) => set("mmproj", e.target.value)}
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
                    label={t("labelContainerName")}
                    param="container_name"
                    error={fieldErrors.containerName}
                  >
                    <Input
                      className="font-mono"
                      placeholder={defaults.docker.container_name}
                      value={drafts.containerName}
                      onChange={(e) => set("containerName", e.target.value)}
                      aria-invalid={!!fieldErrors.containerName || undefined}
                    />
                  </FieldShell>
                  <FieldShell
                    label={t("labelHostPort")}
                    param="host_port"
                    error={fieldErrors.hostPort}
                  >
                    <NumInput
                      value={drafts.hostPort}
                      onChange={(v) => set("hostPort", v)}
                      placeholder={String(defaults.docker.host_port)}
                      invalid={!!fieldErrors.hostPort}
                      step="1"
                    />
                  </FieldShell>
                  <FieldShell label={t("labelImage")} param="image" error={fieldErrors.image}>
                    <Input
                      className="font-mono"
                      placeholder={defaults.docker.image}
                      value={drafts.image}
                      onChange={(e) => set("image", e.target.value)}
                      aria-invalid={!!fieldErrors.image || undefined}
                    />
                  </FieldShell>
                  <FieldShell label={t("labelGpu")} param="gpu" error={fieldErrors.gpuDevices}>
                    <Select
                      value={drafts.gpuMode === "default" ? DEFAULT_OPTION : drafts.gpuMode}
                      onValueChange={(v) =>
                        set(
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
                        onChange={(e) => set("gpuDevices", e.target.value)}
                        aria-invalid={!!fieldErrors.gpuDevices || undefined}
                      />
                    )}
                  </FieldShell>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="flex flex-col gap-3.5">
                <div className="flex items-baseline gap-2">
                  <h2 className="text-sm font-semibold">{t("perfSection")}</h2>
                  <code className="font-mono text-[11px] text-muted-foreground">
                    overrides.server
                  </code>
                </div>
                <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
                  <FieldShell
                    label={t("labelGpuLayers")}
                    param="gpu_layers"
                    error={fieldErrors.gpuLayers}
                  >
                    <NumInput
                      value={drafts.gpuLayers}
                      onChange={(v) => set("gpuLayers", v)}
                      placeholder={String(defaults.server.gpu_layers)}
                      invalid={!!fieldErrors.gpuLayers}
                      step="1"
                    />
                  </FieldShell>
                  <FieldShell
                    label={t("labelCtxSize")}
                    param="ctx_size"
                    error={fieldErrors.ctxSize}
                  >
                    <NumInput
                      value={drafts.ctxSize}
                      onChange={(v) => set("ctxSize", v)}
                      placeholder={String(defaults.server.ctx_size)}
                      invalid={!!fieldErrors.ctxSize}
                      step="1"
                    />
                  </FieldShell>
                  <FieldShell
                    label={t("labelCacheK")}
                    param="cache_type_k"
                    error={fieldErrors.cacheK}
                  >
                    <Select
                      value={drafts.cacheK === "" ? DEFAULT_OPTION : drafts.cacheK}
                      onValueChange={(v) => set("cacheK", v === DEFAULT_OPTION ? "" : String(v))}
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
                    label={t("labelCacheV")}
                    param="cache_type_v"
                    error={fieldErrors.cacheV}
                  >
                    <Select
                      value={drafts.cacheV === "" ? DEFAULT_OPTION : drafts.cacheV}
                      onValueChange={(v) => set("cacheV", v === DEFAULT_OPTION ? "" : String(v))}
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
                    label={t("labelFlashAttn")}
                    param="flash_attention"
                    error={fieldErrors.flashAttn}
                  >
                    <Select
                      value={drafts.flashAttn === "" ? DEFAULT_OPTION : drafts.flashAttn}
                      onValueChange={(v) =>
                        set("flashAttn", v === DEFAULT_OPTION ? "" : String(v))
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
                    label={t("labelThinking")}
                    param="enable_thinking"
                    error={fieldErrors.thinking}
                  >
                    <div className="flex h-8 items-center gap-2.5">
                      <Switch
                        checked={preview.merged.server.enable_thinking}
                        onCheckedChange={(v) => set("thinking", String(v))}
                      />
                      {overriddenKeys.has("server.enable_thinking") ? (
                        <button
                          type="button"
                          onClick={() => set("thinking", "")}
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
                <FieldShell label={t("labelTemp")} param="temp" error={fieldErrors.temp}>
                  <NumInput
                    value={drafts.temp}
                    onChange={(v) => set("temp", v)}
                    placeholder={String(defaults.server.temp)}
                    invalid={!!fieldErrors.temp}
                    step="any"
                  />
                </FieldShell>
                <FieldShell label={t("labelTopP")} param="top_p" error={fieldErrors.topP}>
                  <NumInput
                    value={drafts.topP}
                    onChange={(v) => set("topP", v)}
                    placeholder={String(defaults.server.top_p)}
                    invalid={!!fieldErrors.topP}
                    step="any"
                  />
                </FieldShell>
                <FieldShell label={t("labelTopK")} param="top_k" error={fieldErrors.topK}>
                  <NumInput
                    value={drafts.topK}
                    onChange={(v) => set("topK", v)}
                    placeholder={String(defaults.server.top_k)}
                    invalid={!!fieldErrors.topK}
                    step="1"
                  />
                </FieldShell>
                <FieldShell label={t("labelMinP")} param="min_p" error={fieldErrors.minP}>
                  <NumInput
                    value={drafts.minP}
                    onChange={(v) => set("minP", v)}
                    placeholder={String(defaults.server.min_p)}
                    invalid={!!fieldErrors.minP}
                    step="any"
                  />
                </FieldShell>
                <FieldShell
                  label={t("labelRepeatPenalty")}
                  param="repeat_penalty"
                  error={fieldErrors.repeatPenalty}
                >
                  <NumInput
                    value={drafts.repeatPenalty}
                    onChange={(v) => set("repeatPenalty", v)}
                    placeholder={String(defaults.server.repeat_penalty)}
                    invalid={!!fieldErrors.repeatPenalty}
                    step="any"
                  />
                </FieldShell>
                <FieldShell
                  label={t("labelPresencePenalty")}
                  param="presence_penalty"
                  error={fieldErrors.presencePenalty}
                >
                  <NumInput
                    value={drafts.presencePenalty}
                    onChange={(v) => set("presencePenalty", v)}
                    placeholder={String(defaults.server.presence_penalty)}
                    invalid={!!fieldErrors.presencePenalty}
                    step="any"
                  />
                </FieldShell>
              </div>
            </details>

            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" disabled={saving}>
                {saving && <Loader2 className="animate-spin" />}
                {saving ? t("saving") : t("save")}
              </Button>
              <Button type="button" variant="ghost" onClick={onDiscard}>
                {t("discard")}
              </Button>
              {saved && <span className="text-xs font-medium text-accent-green">{t("saved")}</span>}
              <span className="text-xs text-muted-foreground">{t("saveHint")}</span>
            </div>
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
      </form>

      <Card className="ring-destructive/25">
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 className="text-sm font-semibold text-destructive">
              {t("dangerSection")} · {t("dangerTitle")}
            </h2>
            <p className="text-xs text-muted-foreground">{t("dangerDescription")}</p>
          </div>
          <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
            <DialogTrigger render={<Button variant="destructive" type="button" />}>
              <Trash2 className="size-3.5" />
              {t("dangerButton")}
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{t("dangerConfirmTitle")}</DialogTitle>
                <DialogDescription>{t("dangerConfirmDescription")}</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose render={<Button variant="outline" />}>{t("cancel")}</DialogClose>
                <Button variant="destructive" disabled={deleting} onClick={onDelete}>
                  {deleting && <Loader2 className="animate-spin" />}
                  {deleting ? t("dangerDeleting") : t("dangerConfirm")}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </CardContent>
      </Card>
    </div>
  );
}
