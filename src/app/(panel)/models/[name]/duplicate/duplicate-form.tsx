"use client";

import { useMemo, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2, TriangleAlert } from "lucide-react";
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
import type { PickerItem } from "@/lib/model-file-picker";
import { useUnsavedGuard } from "@/lib/use-unsaved-guard";
import { cn } from "@/lib/utils";
import { ModelParamsForm, useModelParams } from "@/components/models/model-params-form";
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

/**
 * 模型克隆表单（规格 §5）：预填 → 用户改 → POST /api/v1/models。
 *
 * 与编辑页的两处关键差异：
 * - **提交时才落库**：不先建一条再进编辑页改——后者中途放弃就是一条脏数据
 * - **download 元数据透传但不进表单**：它描述的是「这个 GGUF 从哪来」，
 *   新模板指向同一文件、来源事实不变；放进表单只会让用户以为克隆会触发下载
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
  const router = useRouter();

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

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2.5 w-fit text-muted-foreground"
          nativeButton={false}
          render={<Link href="/models" />}
        >
          <ArrowLeft className="size-3.5" />
          {t("backToList")}
        </Button>
        <div className="flex items-baseline gap-2.5">
          <h1 className="text-base font-semibold tracking-tight">{t("title")}</h1>
          <span className="font-mono text-sm text-muted-foreground">{source.name}</span>
        </div>
        <p className="text-xs text-muted-foreground">
          {t("subtitle", { source: source.display_name })}
        </p>
      </div>

      {banner && (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 break-words">{banner}</span>
        </div>
      )}

      <form onSubmit={onCreate} noValidate>
        <ModelParamsForm
          drafts={drafts}
          onSet={set}
          onReplace={setDrafts}
          fieldErrors={fieldErrors}
          defaults={defaults}
          namespaces={namespaces}
          params={params}
          ggufMeta={null}
          pickerItems={pickerItems}
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
        <div className="mt-3.5 flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={creating || name.trim() === ""}>
            {creating && <Loader2 className="animate-spin" />}
            {creating ? t("creating") : t("create")}
          </Button>
        </div>
      </form>

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
