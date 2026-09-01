"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { ArrowLeft, ArrowRight, FileText, Loader2, Plus, TriangleAlert } from "lucide-react";

import type { DefaultConfig, Overrides } from "@/core/schemas";
import { PageHeader } from "@/components/shell/page-header";
import { SecondaryNav } from "@/components/shell/secondary-nav";
import { formatSize } from "@/lib/format";
import { apiFetch } from "@/lib/api";
import type { PickerItem } from "@/lib/model-file-picker";
import { initDrafts, PATH_TO_FIELD, type DraftState } from "@/lib/model-form";
import { WIZARD_STEPS, resolveWizardStep, wizardStepState, type WizardStepState } from "@/lib/wizard-steps";
import { computeAutofill, computeInitialAutofill } from "@/lib/wizard-autofill";
import { cn } from "@/lib/utils";

import { ModelFilePicker } from "@/components/models/model-file-picker";
import { ModelParamsForm, useModelParams } from "@/components/models/model-params-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * 新建模型向导（M2 Task 7 起；M16 T8 改二级栏门禁 + `?step=` 深链；
 * 「仓库档案与下载解耦」批 5 起从四步瘦身为两步）：下载已经挪到仓库档案页
 * （`/models/repos`），向导不再承担「找文件」以外的下载职责——
 * 1 文件（在已落盘的 gguf 里选一个，`ModelFilePicker` 弹层）→
 * 2 基本信息 + 参数（名称/命名空间/mmproj 与 docker/性能/采样参数，
 * 整段复用编辑页/克隆页共用的 `ModelParamsForm`，不再自己重写一遍字段）。
 *
 * step 由 URL 派生而非独立 state：`maxReached`（只增不减，刷新重置为 1）
 * 记录本次会话已解锁到第几步，`resolveWizardStep` 据此把 `?step=` 夹到
 * 可达范围内。goStep 前进/回退一律 router.replace（不 push），向导内部
 * 切换不该塞满浏览器后退栈。
 *
 * `?file=<rel>` 深链（仓库档案页「建配置」按钮的落点）：挂载时预选该文件
 * 并直接跳到步骤 2，省掉「明明已经知道要建哪个模型，还要再点一次选择器」
 * 这一步。传入值经 `pathForGroup` 换算——仓库档案页给的是分片组第一个
 * 物理文件的相对路径，多分片模型需要换算回 glob 前缀（`prefix-*.gguf`）
 * 才是 `gguf_file` 应有的形态，与 `ModelFilePicker` 里同一分组算出的
 * value 保持一致，否则会漏掉后续分片。
 *
 * 选中文件（挂载时预选或步骤 1 手动换选）都会触发 `lib/wizard-autofill.ts`
 * 的自动填充：名称/显示名取自文件名，同目录下的 mmproj 有则自动选中——
 * 但用户一旦手动改过 name/displayName/mmproj 中的某一个，换文件不会再
 * 冲掉那个字段，具体判定见该文件的 `applyAutofill`。
 *
 * 提交：POST /api/v1/models（不再有下载入队这一步，文件本就已经在磁盘上），
 * 成功后回列表页。
 */

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function ModelWizard({
  namespaces,
  defaults,
  pickerItems,
  initialFile,
}: {
  namespaces: string[];
  defaults: DefaultConfig;
  pickerItems: PickerItem[];
  /** `?file=` 深链预选的文件（page.tsx 已经把「补 `step=2`」的跳转做在服务端
   * redirect 里，这里只管拿这个值去初始化草稿，不用再自己判断要不要跳步） */
  initialFile: string | null;
}) {
  const t = useTranslations("pages.modelsNew");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  /** 本次会话已解锁到第几步（只增不减，页面刷新重置为 1）；实际渲染的 step
   * 由 `?step=` 经门禁夹出，深链指向未解锁的步会回落到这里。有 initialFile
   * 时直接以 2 起手——服务端 redirect 已经把 `?step=2` 写进了首屏 URL，
   * 这里若仍从 1 起手，`resolveWizardStep` 会因为「未解锁」把它夹回 1 */
  const [maxReached, setMaxReached] = useState(initialFile !== null ? 2 : 1);
  const step = resolveWizardStep(searchParams.get("step") ?? undefined, maxReached);
  /** 提交期错误横幅（模型创建失败，文案不带阶段前缀——只有这一次请求了） */
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  /** 切步：先把 maxReached 抬到 next（只增不减），再 router.replace 写
   * `?step=`——replace 不 push，向导内前进/后退不该塞满浏览器后退栈 */
  function goStep(next: number): void {
    setMaxReached((m) => Math.max(m, next));
    const params = new URLSearchParams(searchParams.toString());
    params.set("step", String(next));
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    setSubmitError(null);
  }

  // ---- 挂载时按 initialFile（或用户在步骤 1 选中的文件）算一次自动填充建议：
  // 名称/显示名取自文件名，mmproj 若同目录下有则自动选中——只算一次存进
  // useState 的初值，不用 useMemo（后续换文件走 onFileSelected，不依赖这份
  // 挂载时的计算结果重算） ----
  const [initialAutofill] = useState(() => computeInitialAutofill(pickerItems, initialFile));

  // ---- 步骤 2：名称（表单其余字段全部下沉到 ModelParamsForm 的草稿里） ----
  const [name, setName] = useState(initialAutofill.name);
  /** 已存在的模型名（查重用，挂载时拉一次；单管理员面板无并发创建窗口） */
  const [takenNames, setTakenNames] = useState<Set<string>>(new Set());

  useEffect(() => {
    apiFetch("/api/v1/models", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { models: { name: string }[] } | null) => {
        if (d) setTakenNames(new Set(d.models.map((m) => m.name)));
      })
      .catch(() => {
        // 查重拉取失败不阻塞表单：服务端 POST /models 的重名守卫兜底
      });
  }, []);

  const nameValid = NAME_PATTERN.test(name);
  const nameTaken = nameValid && takenNames.has(name);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<string, string>>>({});
  const localNameError =
    name === "" ? undefined : nameTaken ? t("nameTaken") : nameValid ? undefined : t("nameInvalid");
  const nameError = fieldErrors.name ?? localNameError;

  // ---- 草稿（ModelParamsForm 共用形态）：新建场景没有既有模型可回填，
  // 用一个全空的 ModelConfig 起草——initDrafts 已经把「参数字段全部留空 =
  // 跟随默认」这条语义算好了，不必在这里重写一遍。gguf_file/display_name/
  // mmproj_file 的初值全部来自 initialAutofill（内部已经处理好 pathForGroup
  // 换算——深链给的是分片组第一个物理文件的相对路径，多分片模型要换算回
  // glob 前缀才是 gguf_file 应有的形态） ----
  const [drafts, setDrafts] = useState<DraftState>(() =>
    initDrafts({
      name: "",
      display_name: initialAutofill.displayName,
      namespace: namespaces[0] ?? "main",
      gguf_file: initialAutofill.ggufFile,
      mmproj_file: initialAutofill.mmproj || undefined,
      overrides: {},
    }),
  );

  function set<K extends keyof DraftState>(key: K, value: DraftState[K]) {
    setDrafts((prev) => ({ ...prev, [key]: value }));
  }

  // 「换文件要不要覆盖用户已手动改过的值」的判定基准：记录三个字段各自
  // 最近一次真正被自动填入的值。用 ref 而不是 state——它只在 onFileSelected
  // 里读写，变化不需要触发重渲染（真正的展示状态是 name/drafts 本身）
  const lastAutoRef = useRef({
    name: initialAutofill.name,
    displayName: initialAutofill.displayName,
    mmproj: initialAutofill.mmproj,
  });

  /** 步骤 1 换选文件：先照常写入 gguf_file，再用 computeAutofill 重算
   * name/displayName/mmproj——用户手动改过的字段会被原样保留，判定细节见
   * lib/wizard-autofill.ts */
  function onFileSelected(value: string): void {
    const picked = pickerItems.find((item) => item.value === value);
    if (picked === undefined) {
      set("ggufFile", value);
      return;
    }
    const next = computeAutofill(pickerItems, picked, {
      name: { value: name, lastAuto: lastAutoRef.current.name },
      displayName: { value: drafts.displayName, lastAuto: lastAutoRef.current.displayName },
      mmproj: { value: drafts.mmproj, lastAuto: lastAutoRef.current.mmproj },
    });
    lastAutoRef.current = {
      name: next.name.lastAuto,
      displayName: next.displayName.lastAuto,
      mmproj: next.mmproj.lastAuto,
    };
    setName(next.name.value);
    setDrafts((prev) => ({ ...prev, ggufFile: value, displayName: next.displayName.value, mmproj: next.mmproj.value }));
  }

  const params = useModelParams({}, drafts, defaults);
  const selectedFile = pickerItems.find((item) => item.value === drafts.ggufFile);

  const step1Valid = drafts.ggufFile.trim() !== "";
  const step2Valid = nameValid && !nameTaken && step1Valid;

  interface SubmitPlan {
    model: {
      name: string;
      display_name: string;
      namespace: string;
      gguf_file: string;
      mmproj_file?: string;
      overrides: Overrides;
    };
  }

  /** 由当前草稿推导提交 payload（与 duplicate-form 的 buildDuplicatePayload
   * 同语义，但没有 download 透传——这里的文件本就已经在磁盘上，不存在
   * 「这份配置是从哪下载来的」这回事）。 */
  function derivePlan(): SubmitPlan {
    return {
      model: {
        name: name.trim(),
        display_name: drafts.displayName.trim() || name.trim(),
        namespace: drafts.namespace,
        gguf_file: drafts.ggufFile.trim(),
        ...(drafts.mmproj.trim() !== "" ? { mmproj_file: drafts.mmproj.trim() } : {}),
        overrides: params.overrides,
      },
    };
  }

  async function onSubmit(): Promise<void> {
    if (submitting || !step2Valid) return;
    setSubmitting(true);
    setSubmitError(null);
    setFieldErrors({});

    const res = await apiFetch("/api/v1/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(derivePlan().model),
    }).catch(() => null);

    if (res === null) {
      setSubmitError(t("errorNetwork"));
      setSubmitting(false);
      return;
    }
    if (res.ok) {
      router.push("/models");
      return;
    }
    if (res.status === 409) {
      setFieldErrors({ name: t("nameTaken") });
      setSubmitting(false);
      return;
    }
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
    if (issues.length === 0) setSubmitError(body?.error ?? t("errorRequest"));
    else if (unmapped.length > 0) setSubmitError(unmapped.join("; "));
    setSubmitting(false);
  }

  // ---- 各步渲染 ----

  const step1Body = (
    <Card>
      <CardContent className="flex flex-col gap-3.5">
        <h2 className="text-sm font-semibold">{t("step1")}</h2>
        <div className="flex items-center gap-3.5 rounded-lg border px-4 py-3.5">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <FileText className="size-4.5" />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate font-mono text-sm font-semibold">
              {drafts.ggufFile.trim() !== "" ? drafts.ggufFile.trim() : t("noFileSelected")}
            </span>
            {selectedFile && (
              <span className="text-xs text-muted-foreground">{formatSize(selectedFile.totalSize)}</span>
            )}
          </div>
          <ModelFilePicker items={pickerItems} field="gguf" onSelect={onFileSelected} />
        </div>
      </CardContent>
    </Card>
  );

  // 基本信息 + docker/性能/采样参数——共用 ModelParamsForm 的 "config" 分节
  // （模型编辑页/另存为页同款，四张卡纵向堆叠、自带 gap-4，此处不用再包一层
  // 外壳 div）。M16 T8 时这里还是四次独立调用（每个 section 一次），随编辑页
  // 那批把 01–04 合并成一格「配置」一起收成一次调用——不单独给向导留旧的四段式，
  // 三个页面共用同一份 section 语义才不会出现"编辑页改了、向导忘了改"的漂移
  const paramsFormProps = {
    drafts,
    onSet: set,
    onReplace: setDrafts,
    fieldErrors,
    defaults,
    namespaces,
    params,
    ggufMeta: null,
    // 新建向导阶段模型还没落库，拿不到 GGUF 元数据，unknown 是正确语义（不是遗漏）
    effortSupport: { state: "unknown", levels: null },
    pickerItems,
  } as const;

  const step2Body = (
    <ModelParamsForm
      section="config"
      {...paramsFormProps}
      identityFields={
        <div className="flex min-w-0 flex-col gap-1.5">
          <Label className="items-baseline">
            <span>{t("labelName")}</span>
            <code className="font-mono text-[11px] font-normal text-muted-foreground">name</code>
          </Label>
          <Input
            className="font-mono"
            placeholder="qwen3-8b"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-invalid={nameError !== undefined || undefined}
            required
            autoFocus
          />
          <p className={cn("text-xs", nameError ? "text-destructive" : "text-muted-foreground")}>
            {nameError ?? t("nameHint")}
          </p>
        </div>
      }
    />
  );

  // ---- 二级栏：两步固定有序集合，编号语义与设置页一致，多一层门禁三态 ----
  const stepNames = [t("step1"), t("step2")];
  const stepMetas: (string | undefined)[] = [
    drafts.ggufFile.trim() !== "" ? drafts.ggufFile.trim() : undefined,
    undefined,
  ];
  const navItems = WIZARD_STEPS.map((n, i) => {
    const state: WizardStepState = wizardStepState(n, step, maxReached);
    return {
      key: String(n),
      name: stepNames[i]!,
      lead: { kind: "number" as const, text: String(n).padStart(2, "0") },
      meta: stepMetas[i],
      state: state === "current" ? undefined : state,
      title: state === "done" ? t("stepDoneTooltip") : state === "locked" ? t("stepLockedTooltip") : undefined,
    };
  });

  return (
    // 二级栏必须贴到应用外壳的框边：main 给 px-[34px] pt-7 pb-12，本页在这一层
    // 用负边距抵消掉，对齐设置页/模型页/文件页同款处理。h- 而非 min-h-：
    // min-h-full 只等于 main 的内容盒（不含抵消掉的 76px），二级栏右边框会
    // 停在离底 76px 处；定高后内容不再撑长 main，中段表单区改由自己滚动，
    // 底部上一步/下一步工具条固定不滚
    <div className="-mx-[34px] -mt-7 -mb-12 flex h-[calc(100%+76px)]">
      <SecondaryNav
        kicker="NEW MODEL"
        title={t("title")}
        items={navItems}
        queryKey="step"
        current={String(step)}
        footer={
          <div className="flex flex-col gap-3 px-4 pt-3.5 pb-4">
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
          icon={Plus}
          title={t("title")}
          subtitle={t("subtitleStep", { name: stepNames[step - 1]! })}
          stats={[{ value: step, unit: "/ 2", label: t("statStep"), tone: "hot" }]}
        />

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-7 py-6">
          {submitError !== null && step === 2 && (
            <div
              role="alert"
              className="flex items-start gap-2.5 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
            >
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              <span className="min-w-0 break-words">{submitError}</span>
            </div>
          )}

          {step === 1 && step1Body}
          {step === 2 && step2Body}
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t px-7 py-4">
          {step > 1 && (
            <Button variant="ghost" onClick={() => goStep(step - 1)}>
              <ArrowLeft className="size-3.5" />
              {t("actionPrev")}
            </Button>
          )}
          <span className="min-w-0 flex-1" />
          {step === 1 && (
            <Button disabled={!step1Valid} onClick={() => goStep(2)}>
              {t("actionNext")}
              <ArrowRight className="size-3.5" />
            </Button>
          )}
          {step === 2 && (
            <Button disabled={submitting || !step2Valid} onClick={() => void onSubmit()}>
              {submitting && <Loader2 className="animate-spin" />}
              {submitting ? t("submitting") : t("actionSubmit")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
