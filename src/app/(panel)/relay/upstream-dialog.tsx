"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiFetch } from "@/lib/api";
import { MAX_ALIASES_PER_UPSTREAM } from "@/lib/upstream-alias";
import {
  aliasConflictRow,
  aliasProblems,
  apiKeyDraftInvalid,
  buildCreateBody,
  buildTestBody,
  buildUpdateBody,
  draftFromView,
  draftProblem,
  emptyDraft,
  fieldProblems,
  type DraftField,
  type FieldProblem,
  type UpstreamDraft,
} from "@/lib/upstream-form";
import type { AliasProblemReason } from "@/lib/upstream-alias";
import type { UpstreamProbeView, UpstreamView } from "@/lib/upstream-types";

/** DraftProblem → 文案键（显式映射，键名拼错在编译期就能看出来） */
/** 别名的问题逐行显示在别名行下，不走这张表 */
const PROBLEM_KEYS: Record<FieldProblem, string> = {
  name: "problemName",
  nameReserved: "problemNameReserved",
  displayName: "problemDisplayName",
  baseUrl: "problemBaseUrl",
  apiKey: "problemApiKey",
};

/** 别名问题原因 → 文案键 */
const ALIAS_REASON_KEYS: Record<AliasProblemReason, string> = {
  format: "aliasFormat",
  length: "aliasLength",
  targetLength: "aliasTargetLength",
  duplicate: "aliasDuplicate",
  ownerName: "aliasOwnerName",
  tooMany: "aliasTooMany",
};

const ALIAS_DATALIST_ID = "upstream-alias-models";

/**
 * 外部上游的新增 / 编辑弹窗。editing 为 null 是新增，否则是编辑该上游。
 * 调用方用 key 让每次打开都是一个新实例（草稿状态随之重置），本组件不处理「重新打开」。
 */
export function UpstreamDialog({
  editing,
  onClose,
  onSaved,
}: {
  editing: UpstreamView | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations("pages.relay.upstreams");
  const mode = editing === null ? "create" : "edit";
  const [draft, setDraft] = useState<UpstreamDraft>(() => (editing === null ? emptyDraft() : draftFromView(editing)));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [probe, setProbe] = useState<UpstreamProbeView | null>(null);

  const [conflictRow, setConflictRow] = useState<number | null>(null);
  // 离开过的字段：空值要等离开过才报错，刚打开的空表单不满屏红字
  const [touched, setTouched] = useState<ReadonlySet<DraftField>>(new Set());

  const problem = draftProblem(draft, mode);
  const rowProblems = aliasProblems(draft);
  const groupProblem = rowProblems.find((p) => p.index === null) ?? null;
  const fieldErrors = fieldProblems(draft, mode, touched);

  function touch(field: DraftField) {
    setTouched((current) => (current.has(field) ? current : new Set(current).add(field)));
  }

  function fieldError(field: DraftField) {
    const key = fieldErrors[field];
    return key === undefined ? null : <p className="text-xs text-destructive">{t(PROBLEM_KEYS[key])}</p>;
  }

  function patchAlias(index: number, next: Partial<UpstreamDraft["aliases"][number]>) {
    setConflictRow(null);
    setDraft((current) => ({
      ...current,
      aliases: current.aliases.map((row, i) => (i === index ? { ...row, ...next } : row)),
    }));
  }

  function patch(next: Partial<UpstreamDraft>) {
    setDraft((current) => ({ ...current, ...next }));
  }

  async function onTest() {
    setTesting(true);
    setProbe(null);
    setError(null);
    const res = await apiFetch("/api/v1/upstreams/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildTestBody(draft, mode)),
    }).catch(() => null);
    setTesting(false);
    if (res === null) setError(t("errorNetwork"));
    else if (res.ok) setProbe((await res.json()) as UpstreamProbeView);
    else setError(res.status === 400 ? t("problemBaseUrl") : t("errorRequest"));
  }

  async function onSave() {
    if (problem !== null || saving) return;
    setSaving(true);
    setError(null);
    setConflictRow(null);
    const res = await apiFetch(editing === null ? "/api/v1/upstreams" : `/api/v1/upstreams/${editing.name}`, {
      method: editing === null ? "POST" : "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(editing === null ? buildCreateBody(draft) : buildUpdateBody(draft)),
    }).catch(() => null);
    setSaving(false);

    if (res === null) setError(t("errorNetwork"));
    else if (res.ok) onSaved();
    else if (res.status === 409) {
      const body = (await res.json().catch(() => null)) as { issues?: { path?: string }[] } | null;
      const row = aliasConflictRow(draft, body?.issues?.[0]?.path);
      if (row !== null) {
        setConflictRow(row);
        setError(t("errorAliasConflict", { alias: draft.aliases[row].alias.trim() }));
      } else setError(t("errorConflict"));
    }
    else if (res.status === 404) setError(t("errorNotFound"));
    else setError(t("errorRequest"));
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing === null ? t("createTitle") : t("editTitle")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        {/* 只有这一段滚动：标题与底部操作栏固定。-mx-4 / px-4 让滚动条贴弹层边缘，
            scrollbar-gutter 在常显滚动条的系统上先留好位置，不压输入框 */}
        <div className="-mx-4 flex min-h-0 flex-col gap-3.5 overflow-y-auto px-4 py-0.5 [scrollbar-gutter:stable]">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="upstream-name">{t("fieldName")}</Label>
            <Input
              id="upstream-name"
              className="font-mono"
              value={draft.name}
              disabled={editing !== null}
              aria-invalid={fieldErrors.name !== undefined}
              onChange={(e) => patch({ name: e.target.value })}
              onBlur={() => touch("name")}
            />
            {fieldError("name")}
            <p className="text-xs text-muted-foreground">{t("fieldNameHint")}</p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="upstream-display">{t("fieldDisplayName")}</Label>
            <Input
              id="upstream-display"
              value={draft.displayName}
              aria-invalid={fieldErrors.displayName !== undefined}
              onChange={(e) => patch({ displayName: e.target.value })}
              onBlur={() => touch("displayName")}
            />
            {fieldError("displayName")}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="upstream-url">{t("fieldBaseUrl")}</Label>
            <Input
              id="upstream-url"
              className="font-mono"
              value={draft.baseUrl}
              aria-invalid={fieldErrors.baseUrl !== undefined}
              onChange={(e) => patch({ baseUrl: e.target.value })}
              onBlur={() => touch("baseUrl")}
            />
            {fieldError("baseUrl")}
            <p className="text-xs text-muted-foreground">{t("fieldBaseUrlHint")}</p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="upstream-key">{t("fieldApiKey")}</Label>
            <Input
              id="upstream-key"
              type="password"
              autoComplete="off"
              className="font-mono"
              value={draft.apiKey}
              disabled={draft.clearApiKey}
              aria-invalid={fieldErrors.apiKey !== undefined}
              onChange={(e) => patch({ apiKey: e.target.value })}
            />
            {fieldError("apiKey")}
            <p className="text-xs text-muted-foreground">
              {editing?.hasApiKey ? t("fieldApiKeyEditHint", { tail: editing.apiKeyTail ?? "" }) : t("fieldApiKeyHint")}
            </p>
            {editing?.hasApiKey && (
              <label className="flex items-center gap-2 text-xs">
                <Checkbox
                  checked={draft.clearApiKey}
                  onCheckedChange={(checked) => patch({ clearApiKey: checked === true, apiKey: "" })}
                />
                {t("clearApiKey")}
              </label>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="upstream-model">{t("fieldUpstreamModel")}</Label>
            <Input
              id="upstream-model"
              className="font-mono"
              value={draft.upstreamModel}
              onChange={(e) => patch({ upstreamModel: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">{t("fieldUpstreamModelHint")}</p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="upstream-note">{t("fieldNote")}</Label>
            <Input id="upstream-note" value={draft.note} onChange={(e) => patch({ note: e.target.value })} />
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <Label>{t("fieldAliases")}</Label>
              <Button
                variant="outline"
                size="sm"
                disabled={draft.aliases.length >= MAX_ALIASES_PER_UPSTREAM}
                onClick={() => patch({ aliases: [...draft.aliases, { alias: "", upstreamModel: "" }] })}
              >
                <Plus className="size-3.5" />
                {t("addAlias")}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t("fieldAliasesHint")}</p>
            {probe !== null && probe.models.length > 0 && (
              <datalist id={ALIAS_DATALIST_ID}>
                {probe.models.map((id) => (
                  <option key={id} value={id} />
                ))}
              </datalist>
            )}
            {draft.aliases.map((row, index) => {
              const rowProblem = rowProblems.find((p) => p.index === index);
              return (
                <div key={index} className="flex flex-col gap-1">
                  <div className="flex items-center gap-1.5">
                    <Input
                      className="font-mono"
                      aria-label={t("aliasName")}
                      placeholder={t("aliasName")}
                      value={row.alias}
                      aria-invalid={rowProblem?.field === "alias" || conflictRow === index}
                      onChange={(e) => patchAlias(index, { alias: e.target.value })}
                    />
                    <Input
                      className="font-mono"
                      list={ALIAS_DATALIST_ID}
                      aria-label={t("aliasTarget")}
                      placeholder={t("aliasTarget")}
                      value={row.upstreamModel}
                      aria-invalid={rowProblem?.field === "upstreamModel"}
                      onChange={(e) => patchAlias(index, { upstreamModel: e.target.value })}
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={t("removeAlias")}
                      title={t("removeAlias")}
                      onClick={() => {
                        setConflictRow(null);
                        patch({ aliases: draft.aliases.filter((_, i) => i !== index) });
                      }}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                  {rowProblem !== undefined && (
                    <p className="text-xs text-destructive">{t(ALIAS_REASON_KEYS[rowProblem.reason])}</p>
                  )}
                  {conflictRow === index && (
                    <p className="text-xs text-destructive">{t("aliasConflict")}</p>
                  )}
                </div>
              );
            })}
            {groupProblem !== null && (
              <p className="text-xs text-destructive">{t(ALIAS_REASON_KEYS[groupProblem.reason])}</p>
            )}
          </div>

          <div className="flex flex-col gap-2 rounded-md border border-dashed p-3">
            <div>
              <Button variant="outline" size="sm" disabled={testing || draft.baseUrl.trim() === "" || apiKeyDraftInvalid(draft)} onClick={onTest}>
                {testing && <Loader2 className="animate-spin" />}
                {testing ? t("testing") : t("test")}
              </Button>
            </div>
            {probe !== null && (
              <p className="text-xs">
                {!probe.ok
                  ? t("testFail", { error: probe.error ?? "" })
                  : probe.status === 200
                    ? t("testOk", { ms: probe.latencyMs })
                    : t("testStatus", { status: probe.status ?? 0 })}
              </p>
            )}
            {probe !== null && probe.models.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <p className="text-xs text-muted-foreground">{t("testModels")}</p>
                <div className="flex flex-wrap gap-1.5">
                  {probe.models.map((id) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => patch({ upstreamModel: id })}
                      className="rounded border px-2 py-0.5 font-mono text-xs hover:bg-muted"
                    >
                      {id}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

        </div>

        <DialogFooter>
          {/* 保存 / 测试返回的错误放在固定的操作栏里，不用滚动就能看到 */}
          {error !== null && <p className="text-xs text-destructive sm:mr-auto sm:self-center">{error}</p>}
          <Button variant="outline" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button disabled={problem !== null || saving} onClick={onSave}>
            {saving && <Loader2 className="animate-spin" />}
            {saving ? t("saving") : t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
