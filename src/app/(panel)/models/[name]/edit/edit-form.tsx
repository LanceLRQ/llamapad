"use client";

import { useMemo, useState, type FormEvent } from "react";
import { useUnsavedGuard } from "@/lib/use-unsaved-guard";
import { toast } from "@/components/toast-store";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Check, Loader2, Pencil, Trash2, TriangleAlert, X } from "lucide-react";
import { useTranslations } from "next-intl";

import type { GgufMetaView } from "@/core/gguf";
import type { DefaultConfig } from "@/core/schemas";
import type { StoredModel } from "@/server/repo/models";
import { PATH_TO_FIELD, initDrafts, type DraftState } from "@/lib/model-form";
import { isEffortAllowed, type EffortSupport } from "@/lib/reasoning-effort";
import {
  EDIT_SECTIONS,
  resolveModelFormSection,
  type ModelFormSection,
} from "@/lib/model-form-sections";
import { formatSize, toGigabytes } from "@/lib/format";
import type { PickerItem } from "@/lib/model-file-picker";
import { ModelParamsForm, useModelParams } from "@/components/models/model-params-form";
import { PageHeader } from "@/components/shell/page-header";
import { SecondaryNav } from "@/components/shell/secondary-nav";
import { Toolbar } from "@/components/shell/toolbar";

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

/**
 * 模型编辑表单（规格 §3；M16 T9 起改二级栏分节 + `?tab=` 深链，本批把基本信息/
 * Docker/性能/采样四格合并成一格「配置」，二级栏收成三格）：模型身份信息 +
 * PUT 保存 + 删除区 + 配置漂移横幅 + 未保存离开确认。参数编辑区（overrides
 * 三态方案、生效参数预览）已抽到 ModelParamsForm 共用组件（编辑页与克隆页共用，
 * 见 model-params-form.tsx 头部的文档注释），本文件不再直接处理那部分逻辑。
 *
 * 二级栏 meta 位（覆盖总数）与顶栏 `.stats` 是全局事实、不随
 * `section` 变化——PageHeader 的身份/读数固定展示这条模型本身，三个分节只是
 * 同一份表单状态的不同取景，不是三个不同的页面。
 *
 * 配置漂移横幅（UX P0 Task 7）：本模型运行中且启动后保存过配置才出现，
 * 提示当前生效参数与已保存配置不一致、需重启后生效——这条 A 级文案跨分节常驻，
 * 不随 `?tab=` 切换消失。
 *
 * 危险区（`section === "danger"`）是页面级内容，不属于 ModelParamsForm（克隆页
 * 没有这一节），删除确认量化"删的是配置、留的是多大的文件"（ggufSummary 的
 * 体积/分片数），运行中锁定删除按钮（服务端 409 兜底，前端先行禁用）。
 */

export function EditForm({
  model,
  defaults,
  namespaces,
  ggufSummary,
  ggufMeta,
  effortSupport,
  running,
  configStale,
  pickerItems,
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
  /** 本模型当前运行中（保存放行 + "重启后生效"提示；409 守卫已放开仅限编辑） */
  running: boolean;
  /** 配置漂移（UX P0 Task 7）：本模型运行中且启动后保存过配置 */
  configStale: boolean;
  /** 文件选择弹层的候选项（规格 §4）：server component 扫盘装配后直接下发，
   *  不经客户端请求，router.refresh() 也能顺带刷新 */
  pickerItems: PickerItem[];
}) {
  const t = useTranslations("pages.modelEdit");
  const tm = useTranslations("pages.models");
  const router = useRouter();
  // 分节由本组件自己从 useSearchParams() 读（对齐 downloads-view.tsx 的 view 与
  // wizard.tsx 的 step）：meta 位的覆盖计数是每次渲染都要重算的表单派生数据，
  // 不能在 server 侧算，page.tsx 完全不碰 section，避免两处状态源不一致
  const searchParams = useSearchParams();
  const section = resolveModelFormSection(searchParams.get("tab") ?? undefined, EDIT_SECTIONS);

  const [drafts, setDrafts] = useState<DraftState>(() => initDrafts(model));
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<string, string>>>({});
  const [banner, setBanner] = useState<{ kind: "error" | "conflict"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);

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
  // overriddenKeys 供下方危险区删除确认对话框展示"影响 N 项覆盖"，以及二级栏 meta 位的覆盖总数
  const { overrides, overriddenKeys } = params;

  async function onSave(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (saving) return;
    setBanner(null);
    setFieldErrors({});

    // 前置校验（领域约束，见 lib/reasoning-effort.ts 头部文档）：值域外的 reasoning_effort
    // 不会被 zod 挡下（schema 只校验字符串，不知道"这个模型的模板认哪些值"），容器会照常
    // 启动、健康检查照常通过，只在真正发一次带这个值的推理请求时才 500——必须在这里前置拦。
    if (!isEffortAllowed(drafts.effort, effortSupport)) {
      setFieldErrors({ effort: t("errorEffortNotAllowed") });
      return;
    }

    setSaving(true);
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

  // 二级栏（M16 T9 起；本批把基本信息/Docker/性能/采样合并回一格「配置」）：
  // 三格固定有序集合，编号语义与设置页/向导一致，只有危险区前导位换成图标——
  // 它不是"流程第 3 步"，是一个独立的、跳出常规编辑流的操作
  const sectionName: Record<ModelFormSection, string> = {
    config: t("configSection"),
    preview: t("previewTitle"),
    danger: t("dangerSection"),
  };
  const sectionMeta: Record<ModelFormSection, string> = {
    // 二级栏 meta 位显示的覆盖总数：合并成一格之后页面更长、滚动更多，
    // 「我到底改了哪些」比合并前更容易丢失全局感，这个数字把它找回来。
    // overriddenKeys 本身就是覆盖键的全集，直接取 size 即可
    config:
      overriddenKeys.size > 0
        ? t("navOverrideCount", { count: overriddenKeys.size })
        : t("navConfigMeta"),
    preview: t("navPreviewMeta", { count: overriddenKeys.size }),
    danger: t("navDangerMeta"),
  };
  const navItems = EDIT_SECTIONS.map(({ key, number }) =>
    key === "danger"
      ? {
          key,
          name: sectionName.danger,
          meta: sectionMeta.danger,
          lead: { kind: "icon" as const, icon: TriangleAlert },
          tone: "danger" as const,
        }
      : {
          key,
          name: sectionName[key],
          meta: sectionMeta[key],
          lead: { kind: "number" as const, text: number },
        },
  );

  return (
    // 二级栏必须贴到应用外壳的框边：main 给 px-[34px] pt-7 pb-12，本页在这一层
    // 用负边距抵消掉（T1→T11 迁移期的过渡做法，对齐设置页/向导，T4b 之后各页
    // 统一处理，届时这段注释与负边距一起删）
    //
    // h- 而非 min-h-：min-h-full 只等于 main 的内容盒（不含抵消掉的
    // pt-7 28 + pb-12 48 = 76px），二级栏右边框会停在离底 76px 处；定高后
    // 内容不再撑长 main，表单正文改由自己滚动，上方保存工具条固定不滚
    <div className="-mx-[34px] -mt-7 -mb-12 flex h-[calc(100%+76px)]">
      <SecondaryNav
        kicker="EDIT"
        title={t("title")}
        items={navItems}
        queryKey="tab"
        current={section}
        groups={[{ beforeKey: "danger" }]}
        header={
          // 返回出口必须排在列表最前面：这一页的二级栏最后一格是危险区（删除配置），
          // 放底部会让「离开这一页」的出口排在一个不可逆操作之后（设计稿 n2-back 也在顶部）
          <div className="px-4 pt-3.5">
            <Button
              variant="ghost"
              size="sm"
              className="-ml-1 w-fit text-muted-foreground"
              nativeButton={false}
              render={<Link href="/models" />}
            >
              <ArrowLeft className="size-3.5" />
              {t("backToList")}
            </Button>
          </div>
        }
        footer={
          <div className="flex flex-col gap-3 px-4 pt-3.5 pb-4">
            <p className="text-xs text-muted-foreground">
              {t.rich("deeplinkHint", {
                code: (chunks) => (
                  <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground">
                    {chunks}
                  </code>
                ),
              })}
            </p>
          </div>
        }
      />

      <div className="flex min-w-0 flex-1 flex-col">
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

        {/* min-h-0 不能省：flex item 的 min-height 默认是 auto，不加就拒绝收缩到
            内容高度以下，本层一撑高，下面那个 overflow-y-auto 永远拿不到受限高度，
            滚动就跑到外壳的 <main> 上去了（表头与保存工具条跟着一起滚走）。
            新建向导没有这一层 form，所以它一直是对的 */}
        <form onSubmit={onSave} noValidate className="flex min-h-0 min-w-0 flex-1 flex-col">
          <Toolbar
            chips={[]}
            activeChip=""
            onChipChange={() => {}}
            action={
              <>
                {saved && (
                  <span className="text-xs font-medium text-accent-green">
                    {running ? t("savedRestartNote") : t("saved")}
                  </span>
                )}
                <span className="text-xs text-muted-foreground">{t("saveHint")}</span>
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
              </>
            }
          />

          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-7 py-6">
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
                onReplace={(next) => {
                  setDrafts(next);
                  // 有意补上 setSaved(false)：原版参数预设按钮直接调 setDrafts，
                  // 绕过了逐键写入用的 set()，漏了这个副作用——保存成功后点预设，
                  // "已保存"绿字会继续挂着，而 dirty 其实已经变 true，是误导态。
                  // 这里顺带对齐到与普通字段编辑一致的行为，不是遗漏，不要删掉。
                  setSaved(false);
                }}
                fieldErrors={fieldErrors}
                defaults={defaults}
                namespaces={namespaces}
                params={params}
                ggufMeta={ggufMeta}
                effortSupport={effortSupport}
                pickerItems={pickerItems}
              />
            )}
          </div>
        </form>
      </div>

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
