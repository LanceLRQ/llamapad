"use client";

import { useMemo, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Copy, Loader2, Plus, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";

import type { DefaultConfig } from "@/core/schemas";
import type { StoredModel } from "@/server/repo/models";
import { apiFetch } from "@/lib/api";
import {
  PATH_TO_FIELD,
  buildDuplicatePayload,
  initDuplicateDrafts,
  type DraftState,
} from "@/lib/model-form";
import {
  DUPLICATE_SECTIONS,
  countSectionOverrides,
  resolveModelFormSection,
  type ModelFormSection,
} from "@/lib/model-form-sections";
import type { PickerItem } from "@/lib/model-file-picker";
import { useUnsavedGuard } from "@/lib/use-unsaved-guard";
import { ModelParamsForm, useModelParams } from "@/components/models/model-params-form";
import { PageHeader } from "@/components/shell/page-header";
import { SecondaryNav } from "@/components/shell/secondary-nav";
import { Toolbar } from "@/components/shell/toolbar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/**
 * 模型克隆表单（规格 §5；M16 T9 改二级栏五分节 + `?tab=` 深链，无危险区——
 * 新模板还不存在，没有"删除"这回事）。
 *
 * 与编辑页的两处关键差异：
 * - **提交时才落库**：不先建一条再进编辑页改——后者中途放弃就是一条脏数据
 * - **download 元数据透传但不进表单**：它描述的是「这个 GGUF 从哪来」，
 *   新模板指向同一文件、来源事实不变；放进表单只会让用户以为克隆会触发下载
 *
 * i18n 分工：本页专属文案（标题/副题/模型 id 字段）在 pages.modelDuplicate；
 * 与编辑页共用的分节名/meta/深链提示复用 pages.modelEdit（ModelParamsForm
 * 本身也是这样分工的，不为克隆页复制一份同义键）。
 */
export function DuplicateForm({
  source,
  defaults,
  namespaces,
  pickerItems,
}: {
  source: StoredModel;
  defaults: DefaultConfig;
  namespaces: string[];
  pickerItems: PickerItem[];
}) {
  const t = useTranslations("pages.modelDuplicate");
  const tm = useTranslations("pages.modelEdit");
  const router = useRouter();
  const searchParams = useSearchParams();
  const section = resolveModelFormSection(searchParams.get("tab") ?? undefined, DUPLICATE_SECTIONS);

  const initial = useMemo(
    () => initDuplicateDrafts(source, t("displayNameCopySuffix")),
    [source, t],
  );
  const [name, setName] = useState("");
  const [drafts, setDrafts] = useState<DraftState>(initial);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<string, string>>>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // 脏标记：填了 id 或动过任何参数即视为有未提交内容
  const dirty = name !== "" || JSON.stringify(drafts) !== JSON.stringify(initial);
  const { pendingHref, confirmLeave, cancelLeave } = useUnsavedGuard(dirty);

  const params = useModelParams(source.overrides ?? {}, drafts, defaults);
  const overrideCounts = countSectionOverrides(Array.from(params.overriddenKeys));

  function set<K extends keyof DraftState>(key: K, value: DraftState[K]) {
    setDrafts((prev) => ({ ...prev, [key]: value }));
  }

  async function onCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (creating) return;
    setCreating(true);
    setBanner(null);
    setFieldErrors({});

    const res = await apiFetch("/api/v1/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildDuplicatePayload(name, drafts, source, params.overrides)),
    }).catch(() => null);

    if (!res) {
      setBanner(t("errorNetwork"));
    } else if (res.ok) {
      // 克隆的典型下一步是继续调参或直接启动，落在编辑页比落回列表少一次点击
      router.push(`/models/${name.trim()}/edit`);
      return;
    } else if (res.status === 409) {
      setFieldErrors({ name: t("errorDuplicateName") });
    } else if (res.status === 400) {
      const body = (await res.json().catch(() => null)) as {
        issues?: { path: string; message: string }[];
        error?: string;
      } | null;
      const issues = body?.issues ?? [];
      const next: Partial<Record<string, string>> = {};
      const unmapped: string[] = [];
      for (const issue of issues) {
        const field = PATH_TO_FIELD[issue.path];
        if (field) next[field] = issue.message;
        else unmapped.push(`${issue.path}: ${issue.message}`);
      }
      setFieldErrors(next);
      if (issues.length === 0) setBanner(body?.error ?? t("errorRequest"));
      else if (unmapped.length > 0) setBanner(unmapped.join("; "));
    } else {
      setBanner(t("errorRequest"));
    }
    setCreating(false);
  }

  // 二级栏（M16 T9）：五格固定有序集合，分节名/meta 复用编辑页同一套文案——
  // 两页描述的是同一份表单，没有理由说两套话。类型上仍是完整的 ModelFormSection
  // （含用不到的 danger），与 DUPLICATE_SECTIONS 的元素类型对齐，省一次类型断言——
  // 反正 DUPLICATE_SECTIONS 里根本不存在 "danger" 这个 key，取不到那一项
  const sectionName: Record<ModelFormSection, string> = {
    basic: tm("basicSection"),
    docker: tm("dockerSection"),
    perf: tm("perfSection"),
    sampling: tm("samplingSection"),
    preview: tm("previewTitle"),
    danger: tm("dangerSection"),
  };
  const sectionMeta: Record<ModelFormSection, string> = {
    basic: tm("navBasicMeta"),
    docker:
      overrideCounts.docker > 0
        ? tm("navOverrideCount", { count: overrideCounts.docker })
        : tm("navDockerMeta"),
    perf:
      overrideCounts.perf > 0
        ? tm("navOverrideCount", { count: overrideCounts.perf })
        : tm("navFollowDefault"),
    sampling:
      overrideCounts.sampling > 0
        ? tm("navOverrideCount", { count: overrideCounts.sampling })
        : tm("navFollowDefault"),
    preview: tm("navPreviewMeta", { count: overrideCounts.preview }),
    danger: tm("navDangerMeta"),
  };
  const navItems = DUPLICATE_SECTIONS.map(({ key, number }) => ({
    key,
    name: sectionName[key],
    meta: sectionMeta[key],
    lead: { kind: "number" as const, text: number },
  }));

  return (
    // 二级栏必须贴到应用外壳的框边：main 给 px-[34px] pt-7 pb-12，本页在这一层
    // 用负边距抵消掉（对齐编辑页同款处理，T4b 之后各页统一处理，届时这段
    // 注释与负边距一起删）。h- 而非 min-h-：min-h-full 只等于 main 的内容盒
    // （不含抵消掉的 pt-7 28 + pb-12 48 = 76px），二级栏右边框会停在离底
    // 76px 处；定高后内容不再撑长 main，表单正文改由自己滚动，上方新建
    // 工具条固定不滚
    <div className="-mx-[34px] -mt-7 -mb-12 flex h-[calc(100%+76px)]">
      <SecondaryNav
        kicker="SAVE AS"
        title={t("title")}
        items={navItems}
        queryKey="tab"
        current={section}
        header={
          // 返回出口排在列表最前面（设计稿 n2-back 在顶部；对齐编辑页同款处理）
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
              {tm.rich("deeplinkHint", {
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
          icon={Copy}
          title={t("title")}
          // 副题给源模型 id 而不是 display_name：编辑页同一个副题槽放的就是 id
          // （那边的 title 才是 display_name），两个姐妹页的同一个位置该是同一种东西；
          // id 也更精确——display_name 可以重名，id 不会
          subtitle={t("subtitleShort", { source: source.name })}
          // 只加「覆盖」一项：这是这页唯一有意义的读数——从原模型带过来多少改动。
          // 设计稿另一项「大小」刻意不做，duplicate/page.tsx 的文件注释已经写明
          // 这页不查运行状态/不解析 GGUF 头/不算配置漂移——同一条理由也拦住了
          // 磁盘大小这个派生自「文件系统事实」的读数，不为它破例
          stats={[{ value: params.overriddenKeys.size, label: tm("statOverrides"), tone: "hot" }]}
        />

        <form onSubmit={onCreate} noValidate className="flex min-w-0 flex-1 flex-col">
          <Toolbar
            chips={[]}
            activeChip=""
            onChipChange={() => {}}
            action={
              <Button type="submit" size="sm" disabled={creating || name.trim() === ""}>
                {creating ? <Loader2 className="animate-spin" /> : <Plus className="size-3.5" />}
                {creating ? t("creating") : t("create")}
              </Button>
            }
          />

          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-7 py-6">
            {banner && (
              <div
                role="alert"
                className="flex items-start gap-2.5 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
              >
                <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                <span className="min-w-0 break-words">{banner}</span>
              </div>
            )}

            <ModelParamsForm
              section={section}
              drafts={drafts}
              onSet={set}
              onReplace={setDrafts}
              fieldErrors={fieldErrors}
              defaults={defaults}
              namespaces={namespaces}
              params={params}
              ggufMeta={null}
              pickerItems={pickerItems}
              basicNote={
                <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
              }
              identityFields={
                <div className="flex min-w-0 flex-col gap-1.5">
                  <Label className="items-baseline">
                    <span>{t("labelName")}</span>
                    <code className="font-mono text-[11px] font-normal text-muted-foreground">name</code>
                  </Label>
                  <Input
                    className="font-mono"
                    placeholder="qwen3-8b-64k"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    aria-invalid={!!fieldErrors.name || undefined}
                    required
                    autoFocus
                  />
                  <p
                    className={cn(
                      "text-xs",
                      fieldErrors.name ? "text-destructive" : "text-muted-foreground",
                    )}
                  >
                    {fieldErrors.name ?? t("nameHint")}
                  </p>
                </div>
              }
            />
          </div>
        </form>
      </div>

      <Dialog
        open={pendingHref !== null}
        onOpenChange={(next) => (next ? undefined : cancelLeave())}
      >
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
