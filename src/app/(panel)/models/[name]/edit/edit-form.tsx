"use client";

import { useMemo, useState, type FormEvent } from "react";
import { useUnsavedGuard } from "@/lib/use-unsaved-guard";
import { toast } from "@/components/toast-store";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2, Trash2, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";

import type { GgufMeta } from "@/core/gguf";
import type { DefaultConfig } from "@/core/schemas";
import type { StoredModel } from "@/server/repo/models";
import { PATH_TO_FIELD, initDrafts, type DraftState } from "@/lib/model-form";
import type { PickerItem } from "@/lib/model-file-picker";
import { ModelParamsForm, useModelParams } from "@/components/models/model-params-form";

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
import { formatSize } from "@/lib/format";
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

export function EditForm({
  model,
  defaults,
  namespaces,
  ggufSummary,
  ggufMeta,
  running,
  configStale,
  pickerItems,
}: {
  model: StoredModel;
  defaults: DefaultConfig;
  namespaces: string[];
  /** gguf（含分片）体积与分片数：删除确认量化"留在磁盘上的东西" */
  ggufSummary: { sizeBytes: number; fileCount: number };
  /** GGUF 头解析结果（UX P1 U16 后半）：null 表示文件缺失/损坏/未解析，信息行与越界提示整体不显示 */
  ggufMeta: GgufMeta | null;
  /** 本模型当前运行中（保存放行 + "重启后生效"提示；409 守卫已放开仅限编辑） */
  running: boolean;
  /** 配置漂移（UX P0 Task 7）：本模型运行中且启动后保存过配置 */
  configStale: boolean;
  /** 文件选择弹层的候选项（任务 5 接入；本任务先由页面传空数组） */
  pickerItems: PickerItem[];
}) {
  const t = useTranslations("pages.modelEdit");
  const tgi = useTranslations("pages.models.ggufInfo");
  const router = useRouter();
  const [drafts, setDrafts] = useState<DraftState>(() => initDrafts(model));
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<string, string>>>({});
  const [banner, setBanner] = useState<{ kind: "error" | "conflict"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // 脏标记（UX P0 Task 11）：草稿偏离初始值即未保存；结构为可 JSON 化的扁平值
  const dirty = useMemo(
    () => JSON.stringify(drafts) !== JSON.stringify(initDrafts(model)),
    [drafts, model],
  );
  const { pendingHref, confirmLeave, cancelLeave } = useUnsavedGuard(dirty);

  function set<K extends keyof DraftState>(key: K, value: DraftState[K]) {
    setDrafts((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  }

  const params = useModelParams(model.overrides ?? {}, drafts, defaults);
  // overriddenKeys 供下方危险区删除确认对话框展示"影响 N 项覆盖"
  const { overrides, overriddenKeys } = params;

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
      // 运行中保存（守卫已放开）：即时说明"重启后生效"，refresh 后横幅常驻补充
      if (running) toast.info(t("savedWhileRunning"));
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

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2.5 w-fit text-muted-foreground"
          nativeButton={false} render={<Link href="/models" />}
        >
          <ArrowLeft className="size-3.5" />
          {t("backToList")}
        </Button>
        <div className="flex items-baseline gap-2.5">
          <h1 className="text-base font-semibold tracking-tight">{t("title")}</h1>
          <span className="font-mono text-sm text-muted-foreground">{model.name}</span>
        </div>
        {/* GGUF 信息行（U16 后半）：三项缺一即不渲染，避免半截信息误导用户 */}
        {ggufMeta && ggufMeta.architecture !== null && ggufMeta.blockCount !== null && ggufMeta.contextLength !== null && (
          <p className="font-mono text-xs text-muted-foreground">
            {tgi("line", {
              arch: ggufMeta.architecture,
              blocks: ggufMeta.blockCount,
              ctx: ggufMeta.contextLength,
            })}
          </p>
        )}
      </div>

      {configStale && (
        <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-700 dark:text-amber-400">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span>{t("configStaleBanner")}</span>
        </div>
      )}

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
        <ModelParamsForm
          drafts={drafts}
          onSet={set}
          onReplace={(next) => {
            setDrafts(next);
            setSaved(false);
          }}
          fieldErrors={fieldErrors}
          defaults={defaults}
          namespaces={namespaces}
          params={params}
          ggufMeta={ggufMeta}
          pickerItems={pickerItems}
        />

        <div className="mt-3.5 flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="animate-spin" />}
            {saving ? t("saving") : t("save")}
          </Button>
          <Button type="button" variant="ghost" onClick={onDiscard}>
            {t("discard")}
          </Button>
          {saved && (
            <span className="text-xs font-medium text-accent-green">
              {running ? t("savedRestartNote") : t("saved")}
            </span>
          )}
          <span className="text-xs text-muted-foreground">{t("saveHint")}</span>
        </div>
      </form>

      <Card className="ring-destructive/25">
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 className="text-sm font-semibold text-destructive">
              {t("dangerSection")} · {t("dangerTitle")}
            </h2>
            <p className="text-xs text-muted-foreground">{t("dangerDescription")}</p>
            {/* 运行中锁定删除（服务端 409 兜底，前端先行禁用 + 说明） */}
            {running && (
              <p className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                <TriangleAlert className="size-3.5 shrink-0" />
                {t("dangerLockedRunning")}
              </p>
            )}
          </div>
          <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
            <DialogTrigger
              render={
                <Button
                  variant="destructive"
                  type="button"
                  disabled={running}
                  title={running ? t("dangerLockedRunning") : undefined}
                />
              }
            >
              <Trash2 className="size-3.5" />
              {t("dangerButton")}
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{t("dangerConfirmTitle")}</DialogTitle>
                <DialogDescription>
                  {ggufSummary.sizeBytes > 0
                    ? t("dangerConfirmDescription", {
                        overrides: overriddenKeys.size,
                        size: formatSize(ggufSummary.sizeBytes),
                        files: ggufSummary.fileCount,
                      })
                    : t("dangerConfirmDescriptionNoFiles", { overrides: overriddenKeys.size })}
                </DialogDescription>
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

      {/* 未保存离开确认（UX P0 Task 11）：站内链接被拦后在此裁决 */}
      <Dialog open={pendingHref !== null} onOpenChange={(next) => (next ? undefined : cancelLeave())}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("unsavedTitle")}</DialogTitle>
            <DialogDescription>{t("unsavedBody")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>{t("unsavedStay")}</DialogClose>
            <Button variant="destructive" onClick={confirmLeave}>
              {t("unsavedLeave")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
