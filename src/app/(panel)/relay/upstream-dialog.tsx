"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";

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
import {
  apiKeyDraftInvalid,
  buildCreateBody,
  buildTestBody,
  buildUpdateBody,
  draftFromView,
  draftProblem,
  emptyDraft,
  type DraftProblem,
  type UpstreamDraft,
} from "@/lib/upstream-form";
import type { UpstreamProbeView, UpstreamView } from "@/lib/upstream-types";

/** DraftProblem → 文案键（显式映射，键名拼错在编译期就能看出来） */
const PROBLEM_KEYS: Record<DraftProblem, string> = {
  name: "problemName",
  nameReserved: "problemNameReserved",
  displayName: "problemDisplayName",
  baseUrl: "problemBaseUrl",
  apiKey: "problemApiKey",
};

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

  const problem = draftProblem(draft, mode);

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
    const res = await apiFetch(editing === null ? "/api/v1/upstreams" : `/api/v1/upstreams/${editing.name}`, {
      method: editing === null ? "POST" : "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(editing === null ? buildCreateBody(draft) : buildUpdateBody(draft)),
    }).catch(() => null);
    setSaving(false);

    if (res === null) setError(t("errorNetwork"));
    else if (res.ok) onSaved();
    else if (res.status === 409) setError(t("errorConflict"));
    else if (res.status === 404) setError(t("errorNotFound"));
    else setError(t("errorRequest"));
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing === null ? t("createTitle") : t("editTitle")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3.5">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="upstream-name">{t("fieldName")}</Label>
            <Input
              id="upstream-name"
              className="font-mono"
              value={draft.name}
              disabled={editing !== null}
              onChange={(e) => patch({ name: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">{t("fieldNameHint")}</p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="upstream-display">{t("fieldDisplayName")}</Label>
            <Input id="upstream-display" value={draft.displayName} onChange={(e) => patch({ displayName: e.target.value })} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="upstream-url">{t("fieldBaseUrl")}</Label>
            <Input
              id="upstream-url"
              className="font-mono"
              value={draft.baseUrl}
              onChange={(e) => patch({ baseUrl: e.target.value })}
            />
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
              onChange={(e) => patch({ apiKey: e.target.value })}
            />
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

          {problem !== null && <p className="text-xs text-muted-foreground">{t(PROBLEM_KEYS[problem])}</p>}
          {error !== null && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
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
