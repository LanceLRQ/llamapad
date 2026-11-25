"use client";

import { useContext, useMemo, useRef, useState, type FormEvent } from "react";
import { useUnsavedGuard } from "@/lib/use-unsaved-guard";
import { toast } from "@/components/toast-store";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Check, Loader2, Pencil, Trash2, TriangleAlert, X } from "lucide-react";
import { useTranslations } from "next-intl";

import type { GgufMetaView } from "@/core/gguf";
import type { DefaultConfig } from "@/core/schemas";
import type { StoredModel } from "@/server/repo/models";
import { PATH_TO_FIELD, draftLoraAdapters, initDrafts, type DraftState } from "@/lib/model-form";
import type { MtpKind } from "@/lib/mtp-kind";
import { shouldBlockEffortSave, type EffortSupport } from "@/lib/reasoning-effort";
import {
  EDIT_SECTIONS,
  resolveModelFormSection,
  type ModelFormSection,
} from "@/lib/model-form-sections";
import { formatSize, toGigabytes } from "@/lib/format";
import type { PickerItem } from "@/lib/model-file-picker";
import type { PeerPort } from "@/lib/port-peers";
import { ModelParamsForm, useModelParams } from "@/components/models/model-params-form";
import { PageHeader } from "@/components/shell/page-header";
import type { ModelView } from "@/server/modelsView";
import { ProfileEditorContext } from "../../profiles/workspace";

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
import { cn } from "@/lib/utils";
import { apiFetch } from "@/lib/api";

export function EditForm({
  model,
  defaults,
  namespaces,
  ggufSummary,
  ggufMeta,
  effortSupport,
  mtpKind,
  running,
  configStale,
  pickerItems,
  peerPorts,
}: {
  model: StoredModel;
  defaults: DefaultConfig;
  namespaces: string[];
  /** gguf（含分片）体积与分片数：删除确认量化"留在磁盘上的东西" */
  ggufSummary: { sizeBytes: number; fileCount: number };
  /** GGUF 头解析结果（UX P1 U16 后半）；chatTemplate 已剔除，null 表示文件缺失/损坏/未解析，
   *  信息行与越界提示整体不显示 */
  ggufMeta: GgufMetaView | null;
  /** 「思考强度」支持态（page.tsx 用 chatTemplate 判定过一次，本组件只消费结果） */
  effortSupport: EffortSupport;
  /** 主 GGUF 的 MTP 形态（page.tsx 用同一份 gguf_meta 判定过一次）：决定 MTP 开关可开与否 */
  mtpKind: MtpKind | null;
  /** 本模型当前运行中（保存放行 + "重启后生效"提示；409 守卫已放开仅限编辑） */
  running: boolean;
  /** 配置漂移（UX P0 Task 7）：本模型运行中且启动后保存过配置 */
  configStale: boolean;
  /** 文件选择弹层的候选项（规格 §4）：server component 扫盘装配后直接下发，
   *  不经客户端请求，router.refresh() 也能顺带刷新 */
  pickerItems: PickerItem[];
  /** 全部模型的配置端口（端口冲突提示用） */
  peerPorts: PeerPort[];
}) {
  const t = useTranslations("pages.modelEdit");
  const tm = useTranslations("pages.models");
  const router = useRouter();
  const editor = useContext(ProfileEditorContext);
  const formScroll = useRef<HTMLDivElement>(null);
  // 分节由本组件自己从 useSearchParams() 读（对齐 downloads-view.tsx 的 view 与
  // wizard.tsx 的 step）：meta 位的覆盖计数是每次渲染都要重算的表单派生数据，
  // 不能在 server 侧算，page.tsx 完全不碰 section，避免两处状态源不一致
  const searchParams = useSearchParams();
  const section = resolveModelFormSection(searchParams.get("tab") ?? undefined, EDIT_SECTIONS);

  const [drafts, setDrafts] = useState<DraftState>(() => initDrafts(model));
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<string, string>>>({});
  const [banner, setBanner] = useState<{ kind: "error" | "conflict"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);

  // 脏标记（UX P0 Task 11）：草稿偏离初始值即未保存；结构为可 JSON 化的扁平值
  const dirty = useMemo(
    () => JSON.stringify(drafts) !== JSON.stringify(initDrafts(model)),
    [drafts, model],
  );
  const { pendingHref, confirmLeave, cancelLeave } = useUnsavedGuard(dirty, (href) => {
    if (editor && href === "/models/profiles") editor.close();
    else if (editor && /^\/models\/[^/]+\/edit$/.test(href)) router.replace(href, { scroll: false });
    else router.push(href);
  });

  function set<K extends keyof DraftState>(key: K, value: DraftState[K]) {
    setDrafts((prev) => ({ ...prev, [key]: value }));
  }

  const params = useModelParams(model.overrides ?? {}, drafts, defaults);
  const { overrides, overriddenKeys } = params;

  async function onSave(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (saving) return;
    setBanner(null);
    setFieldErrors({});

    // 前置校验（领域约束，见 lib/reasoning-effort.ts 头部文档）：值域外的 reasoning_effort
    // 不会被 zod 挡下（schema 只校验字符串，不知道"这个模型的模板认哪些值"），容器会照常
    // 启动、健康检查照常通过，只在真正发一次带这个值的推理请求时才 500——必须在这里前置拦。
    // shouldBlockEffortSave 而非 isEffortAllowed：思考模式关闭时这个值根本不会进入推理
    // 请求、且字段本身被禁用用户无从修改，继续拦会把保存焊死（真机复现，见该函数头注）。
    // enable_thinking 取合并后的生效值，与 effortFieldState 用的同一份，不用草稿片段。
    if (shouldBlockEffortSave(drafts.effort, effortSupport, params.preview.merged.server.enable_thinking)) {
      setFieldErrors({ effort: t("errorEffortNotAllowed") });
      toast.error(t("errorEffortNotAllowed"));
      return;
    }

    setSaving(true);
    const res = await apiFetch(`/api/v1/models/${model.name}${editor ? "?view=profile" : ""}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        display_name: drafts.displayName.trim(),
        namespace: drafts.namespace,
        gguf_file: drafts.ggufFile.trim(),
        mmproj_file: drafts.mmproj.trim() === "" ? null : drafts.mmproj.trim(),
        draft_file: drafts.draft.trim() === "" ? null : drafts.draft.trim(),
        lora_adapters: draftLoraAdapters(drafts.loraAdapters) ?? null,
        overrides,
      }),
    }).catch(() => null);

    // 保存结果一律走全局提示：成功即离开本页，页内已无处展示结果；失败时页内横幅与
    // 字段标红照常保留（toast 几秒后消失，定位具体哪个字段还得靠它们）
    if (!res) {
      fail({ kind: "error", text: t("errorNetwork") });
    } else if (res.ok) {
      // 运行中保存（守卫已放开）：提示里说明"重启后生效"，列表页运行行也会标出配置已变
      toast.success(running ? t("savedWhileRunning") : t("saved"));
      if (editor) {
        const row: ModelView = await res.json();
        editor.close({ name: model.name, model: row });
      } else {
        router.push("/models/profiles");
      }
      return;
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
        if (unmapped.length > 0) fail({ kind: "error", text: unmapped.join("; ") });
        else toast.error(t("errorFieldsInvalid"));
      } else {
        fail({ kind: "error", text: body?.error ?? t("errorRequest") });
      }
    } else if (res.status === 409) {
      fail({ kind: "conflict", text: t("errorConflict") });
    } else if (res.status === 404) {
      fail({ kind: "error", text: t("errorNotFound") });
    } else {
      fail({ kind: "error", text: t("errorRequest") });
    }
    setSaving(false);
  }

  /** 保存失败：页内横幅常驻 + 全局提示同一句话 */
  function fail(next: { kind: "error" | "conflict"; text: string }) {
    setBanner(next);
    toast.error(next.text);
  }

  function onDiscard() {
    setDrafts(initDrafts(model));
    setFieldErrors({});
    setBanner(null);
  }

  async function onDelete() {
    setDeleting(true);
    const res = await apiFetch(`/api/v1/models/${model.name}`, { method: "DELETE" }).catch(() => null);
    if (res?.ok || res?.status === 404) {
      if (editor) editor.close({ name: model.name, model: null });
      else router.push("/models/profiles");
      return;
    }
    setDeleteOpen(false);
    if (res?.status === 409) setBanner({ kind: "conflict", text: t("errorConflict") });
    else setBanner({ kind: "error", text: res ? t("errorRequest") : t("errorNetwork") });
    setDeleting(false);
  }

  const sectionName: Record<ModelFormSection, string> = {
    config: t("configSection"),
    preview: t("previewTitle"),
    danger: t("dangerSection"),
  };

  function changeSection(next: ModelFormSection) {
    const url = new URL(window.location.href);
    url.searchParams.set("tab", next);
    window.history.replaceState(null, "", url);
    formScroll.current?.scrollTo({ top: 0 });
  }

  return (
    <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", !editor && "-mx-[34px] -mt-7 -mb-12 h-[calc(100%+76px)]")}>
      <div className="flex items-center gap-3 border-b px-4 py-2 sm:px-7">
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 text-muted-foreground"
          nativeButton={false}
          render={<Link href="/models/profiles" prefetch={false} onNavigate={editor ? (event) => {
            event.preventDefault();
            editor.close();
          } : undefined} />}
        >
          <ArrowLeft />
          {t("backToList")}
        </Button>
        <span className="border-l pl-3 text-sm font-medium">{t("title")}</span>
      </div>
      <PageHeader
        icon={Pencil}
        title={model.display_name}
        subtitle={model.name}
        stats={[
          { value: overriddenKeys.size, label: t("statOverrides"), tone: "hot" },
          { value: toGigabytes(ggufSummary.sizeBytes), unit: "GB", label: t("statSize") },
          { value: running ? tm("statusRunning") : tm("statusIdle"), label: t("statStatus") },
        ]}
      />

      <form onSubmit={onSave} noValidate className="flex min-h-0 min-w-0 flex-1 flex-col">
        <nav aria-label={t("title")} className="flex shrink-0 flex-wrap gap-1 border-b px-4 py-2 sm:px-7">
          {EDIT_SECTIONS.map(({ key }) => (
            <Button
              key={key}
              type="button"
              size="sm"
              variant="ghost"
              aria-pressed={key === section}
              className={cn(key === section && "bg-accent font-semibold", key === "danger" && "text-destructive")}
              onClick={() => changeSection(key)}
            >
              {sectionName[key]}
            </Button>
          ))}
        </nav>

        <div ref={formScroll} className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-7">
          <div className="mx-auto flex max-w-6xl flex-col gap-4">
            {/* A 级：常驻，不随分节切换消失——这是模型整体的状态，不是某一节表单的状态 */}
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

            {section === "danger" ? (
              <Card className="ring-destructive/25">
                <CardContent className="flex flex-col gap-3">
                  <h2 className="text-sm font-semibold text-destructive">{t("dangerTitle")}</h2>
                  {/* A 级：不可逆 + 有隐藏的锁定前置条件，视觉重量与 configStale 同级，别收进悬停 */}
                  <p className="text-sm text-foreground">{t("dangerDescription")}</p>
                  {running && (
                    <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-700 dark:text-amber-400">
                      <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                      <span>{t("dangerLockedRunning")}</span>
                    </div>
                  )}
                  <div className="flex justify-end">
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
                  </div>
                </CardContent>
              </Card>
            ) : (
              <ModelParamsForm
                section={section}
                drafts={drafts}
                onSet={set}
                onReplace={setDrafts}
                fieldErrors={fieldErrors}
                defaults={defaults}
                namespaces={namespaces}
                params={params}
                ggufMeta={ggufMeta}
                effortSupport={effortSupport}
                mtpKind={mtpKind}
                pickerItems={pickerItems}
                peerPorts={peerPorts}
                selfName={model.name}
              />
            )}
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t bg-background px-4 py-3 sm:px-7">
          {/* 重置表单需二次确认：字段多，误触代价是"整份表单重填一遍"，
              直接执行的 ghost 按钮太容易手滑碰到 */}
          <Dialog open={resetOpen} onOpenChange={setResetOpen}>
            <DialogTrigger render={<Button type="button" variant="ghost" size="sm" />}>
              <X className="size-3.5" />
              {t("resetForm")}
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{t("resetFormConfirmTitle")}</DialogTitle>
                <DialogDescription>{t("resetFormConfirmDescription")}</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose render={<Button variant="outline" />}>{t("cancel")}</DialogClose>
                <Button
                  onClick={() => {
                    onDiscard();
                    setResetOpen(false);
                  }}
                >
                  {t("resetFormConfirm")}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <Button type="submit" size="sm" disabled={saving}>
            {saving ? <Loader2 className="animate-spin" /> : <Check className="size-3.5" />}
            {saving ? t("saving") : t("save")}
          </Button>
        </div>
      </form>

      {/* 未保存离开确认（UX P0 Task 11）：站内链接被拦后在此裁决，不随分节切换消失 */}
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
