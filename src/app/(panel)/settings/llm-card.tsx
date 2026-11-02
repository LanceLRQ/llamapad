"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { CheckCircle2, Loader2, Sparkles, Trash2, XCircle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch } from "@/lib/api";
import { isValidExtraBody } from "@/lib/llm-extra-body";
import { SettingsSaveFooter } from "@/components/settings-save-footer";
import { SettingTip } from "@/components/setting-tip";
import { toast } from "@/components/toast-store";

/** 外部 API 连接按面板整体保存，环境来源只读，密钥不回填。
 * 清除密钥单独确认并立即生效，测试连接只使用已保存配置。
 */

/** 快照形状（与 GET /api/v1/settings/llm 响应及 server/llm/settings.ts 同构，客户端不引 server 模块） */
export interface LlmSettingsSnapshotView {
  baseUrl: string | null;
  baseUrlSource: "env" | "db" | null;
  keySet: boolean;
  keyTail: string | null;
  keySource: "env" | "db" | null;
  model: string | null;
  modelSource: "env" | "db" | null;
  extraBody: string | null;
  extraBodySource: "env" | "db" | null;
  externalReady: boolean;
  missing: ("baseUrl" | "apiKey" | "model")[];
}

/** 测试连接结果（POST /test 的两种响应形状；notConfigured 分支不带 message） */
type TestResult = { ok: true; model: string } | { ok: false; kind: string; message?: string };

/** kind → `pages.repos` 的 `llmError.*` 键：与 llm-extract-panel.tsx 的 ERROR_KEY 同一张映射表
 *  （刻意复用同一组文案，不为设置页另起一套）；认不出的 kind 兜底落 network，不渲染原始键名 */
const ERROR_KEY: Record<string, string> = {
  notConfigured: "llmError.notConfigured",
  noRunningModel: "llmError.noRunningModel",
  unauthorized: "llmError.unauthorized",
  rateLimited: "llmError.rateLimited",
  network: "llmError.network",
  badResponse: "llmError.badResponse",
  noReadme: "llmError.noReadme",
};

export function LlmCard({ initial }: { initial: LlmSettingsSnapshotView }) {
  const t = useTranslations("pages.settings");
  const tRepos = useTranslations("pages.repos");
  const router = useRouter();

  const [snap, setSnap] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Base URL
  const [baseUrlDraft, setBaseUrlDraft] = useState(initial.baseUrl ?? "");

  // API Key：已保存时先显示尾 4 位，点「更换」才切成可输入状态——与 HF Token 同语义，明文不回显、不预填
  const [keyEditing, setKeyEditing] = useState(!initial.keySet);
  const [keyDraft, setKeyDraft] = useState("");
  const [keyBusy, setKeyBusy] = useState<"clear" | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);

  // 模型
  const [modelDraft, setModelDraft] = useState(initial.model ?? "");

  // 额外请求体
  const [extraBodyDraft, setExtraBodyDraft] = useState(initial.extraBody ?? "");
  const [extraBodyInvalid, setExtraBodyInvalid] = useState(false);

  // 测试连接
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  /** 保存与清除共用完整快照响应，失败保留草稿，由调用处显示错误。 */
  async function putSettings(
    body: Record<string, unknown>,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const res = await apiFetch("/api/v1/settings/llm", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    if (res === null) return { ok: false, message: t("errorNetwork") };
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      return { ok: false, message: data?.error ?? t("errorRequest") };
    }
    const patch = (await res.json()) as LlmSettingsSnapshotView;
    setSnap(patch);
    setBaseUrlDraft(patch.baseUrl ?? "");
    setModelDraft(patch.model ?? "");
    setExtraBodyDraft(patch.extraBody ?? "");
    router.refresh();
    toast.success(t("llmSaveDone"));
    return { ok: true };
  }

  async function onClearKey() {
    if (keyBusy !== null || snap.keySource !== "db") return;
    if (saving || dirty || !window.confirm(t("clearFieldConfirm", { field: t("llmApiKeyLabel") }))) return;
    setKeyBusy("clear");
    setKeyError(null);
    const result = await putSettings({ apiKey: null });
    setKeyBusy(null);
    if (result.ok) {
      // 清除后回到编辑态：draft 必须一并清空，否则用户此前输入过又反悔取消的
      // 那串明文会在这次进编辑态时原样回显——「清除」意味着这串明文不该再存在
      setKeyDraft("");
      setKeyEditing(true);
    } else {
      setKeyError(result.message);
    }
  }

  function onExtraBodyBlur() {
    // 校验口径必须与服务端（PUT 路由）一致——不能只查"是合法 JSON"，还要求顶层
    // 是非数组对象，否则 [1,2,3] 这类合法 JSON 但非对象的输入不会红框、点保存
    // 才被服务端拒绝，早期反馈就失效了。判定下沉 lib，与 parseExtraBody 同一份口径
    setExtraBodyInvalid(!isValidExtraBody(extraBodyDraft));
  }

  async function onTest() {
    if (testing) return;
    setTesting(true);
    setTestResult(null);
    const res = await apiFetch("/api/v1/settings/llm/test", { method: "POST" }).catch(() => null);
    setTesting(false);
    if (res === null) {
      setTestResult({ ok: false, kind: "network" });
      return;
    }
    const data = (await res.json().catch(() => null)) as TestResult | null;
    setTestResult(data ?? { ok: false, kind: "network" });
  }

  const dirty = (snap.baseUrlSource !== "env" && baseUrlDraft.trim() !== (snap.baseUrl ?? "")) ||
    (snap.modelSource !== "env" && modelDraft.trim() !== (snap.model ?? "")) ||
    (snap.extraBodySource !== "env" && extraBodyDraft.trim() !== (snap.extraBody ?? "")) ||
    (snap.keySource !== "env" && keyDraft.trim() !== "");
  async function onSave() {
    if (saving || !dirty) return;
    setSaving(true); setSaved(false); setSaveError(null); setKeyError(null); setTestResult(null);
    const result = await putSettings({
      ...(snap.baseUrlSource !== "env" ? { baseUrl: baseUrlDraft.trim() || null } : {}),
      ...(snap.modelSource !== "env" ? { model: modelDraft.trim() || null } : {}),
      ...(snap.extraBodySource !== "env" ? { extraBody: extraBodyDraft.trim() } : {}),
      ...(snap.keySource !== "env" && keyDraft.trim() !== "" ? { apiKey: keyDraft.trim() } : {}),
    });
    if (result.ok) { setKeyDraft(""); setKeyEditing(false); setExtraBodyInvalid(false); setSaved(true); }
    else setSaveError(result.message);
    setSaving(false);
  }

  return (
    <Card className="gap-0 py-0">
      <div className="flex flex-wrap items-center gap-2.5 border-b p-4">
        <Sparkles className="size-4 text-muted-foreground" />
        <h2 className="text-base font-semibold">{t("llmTitle")}</h2>
      </div>

      <fieldset disabled={saving || keyBusy !== null} className="flex min-w-0 flex-col gap-5 p-4">
        {/* 外部 API */}
        <div className="flex flex-col gap-4 border-t pt-4">
          <h3 className="text-xs font-semibold text-muted-foreground">{t("llmExternalTitle")}</h3>

          {/* Base URL */}
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Label htmlFor="llm-baseUrl">{t("llmBaseUrlLabel")}</Label>
              {snap.baseUrlSource === "env" && <Badge variant="outline">{t("llmFromEnv")}</Badge>}
            </div>
            <div className="flex max-w-xl items-center gap-2">
              <Input
                className="font-mono"
                autoComplete="off"
                placeholder={t("llmBaseUrlPlaceholder")}
                id="llm-baseUrl"
                value={baseUrlDraft}
                disabled={snap.baseUrlSource === "env"}
                onChange={(e) => setBaseUrlDraft(e.target.value)}
                aria-invalid={saveError !== null}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void onSave();
                }}
              />
            </div>
            {snap.baseUrlSource === "env" && <p className="text-sm text-foreground">{t("llmFromEnvHint")}</p>}
          </div>

          {/* API Key */}
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Label htmlFor="llm-key">{t("llmApiKeyLabel")}</Label>
              {snap.keySource === "env" && <Badge variant="outline">{t("llmFromEnv")}</Badge>}
            </div>
            {snap.keySource === "env" ? (
              <p className="text-sm text-foreground">{t("llmFromEnvHint")}</p>
            ) : !keyEditing && snap.keySet ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs text-muted-foreground">
                  {snap.keyTail ? t("llmApiKeySavedTail", { tail: snap.keyTail }) : t("llmApiKeySavedNoTail")}
                </span>
                <Button variant="outline" size="sm" onClick={() => setKeyEditing(true)}>
                  {t("llmApiKeyChangeButton")}
                </Button>
                <Button variant="outline" size="sm" disabled={saving || dirty || keyBusy !== null} onClick={onClearKey}>
                  {keyBusy === "clear" ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="size-3.5" />
                  )}
                  {keyBusy === "clear" ? t("llmApiKeyClearing") : t("llmApiKeyClearButton")}
                </Button>
              </div>
            ) : (
              <div className="flex max-w-xl items-center gap-2">
                <Input
                  className="font-mono"
                  type="password"
                  autoComplete="off"
                  placeholder={t("llmApiKeyPlaceholder")}
                  id="llm-key"
                  value={keyDraft}
                  onChange={(e) => setKeyDraft(e.target.value)}
                  aria-invalid={keyError !== null}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void onSave();
                  }}
                />
                {snap.keySet && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      // 取消同样要清空 draft——留着的话下次点「更换」会把这串
                      // 刚刚反悔的明文原样回显，违反「明文永不回显」
                      setKeyDraft("");
                      setKeyEditing(false);
                    }}
                  >
                    {t("llmApiKeyCancelButton")}
                  </Button>
                )}
              </div>
            )}
            {keyError && <p className="text-xs text-destructive">{keyError}</p>}
          </div>

          {/* 模型 */}
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Label htmlFor="llm-model">{t("llmModelLabel")}</Label>
              {snap.modelSource === "env" && <Badge variant="outline">{t("llmFromEnv")}</Badge>}
            </div>
            <div className="flex max-w-xl items-center gap-2">
              <Input
                className="font-mono"
                autoComplete="off"
                placeholder={t("llmModelPlaceholder")}
                id="llm-model"
                value={modelDraft}
                disabled={snap.modelSource === "env"}
                onChange={(e) => setModelDraft(e.target.value)}
                aria-invalid={saveError !== null}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void onSave();
                }}
              />
            </div>
            {snap.modelSource === "env" && <p className="text-sm text-foreground">{t("llmFromEnvHint")}</p>}
          </div>

          {/* 额外请求体 */}
          <details className="text-sm">
            <summary className="cursor-pointer text-xs font-medium text-muted-foreground select-none">
              {t("llmExtraBodySummary")}
            </summary>
            <div className="mt-2 flex max-w-xl flex-col gap-2">
              {snap.extraBodySource === "env" && (
                <>
                  <Badge variant="outline" className="w-fit">
                    {t("llmFromEnv")}
                  </Badge>
                  <p className="text-sm text-foreground">{t("llmFromEnvHint")}</p>
                </>
              )}
              <p className="text-xs text-muted-foreground">{t("llmExtraBodyHint")}</p>
              <Textarea
                className="font-mono text-xs"
                rows={3}
                placeholder={t("llmExtraBodyPlaceholder")}
                value={extraBodyDraft}
                disabled={snap.extraBodySource === "env"}
                onChange={(e) => setExtraBodyDraft(e.target.value)}
                onBlur={onExtraBodyBlur}
                aria-invalid={extraBodyInvalid || saveError !== null}
              />
              {extraBodyInvalid && <p className="text-xs text-destructive">{t("llmExtraBodyInvalid")}</p>}
            </div>
          </details>

          {/* 测试连接 */}
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="outline" size="sm" disabled={testing || dirty || saving} onClick={onTest}>
              {testing ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <CheckCircle2 className="size-3.5" />
              )}
              {testing ? t("llmTesting") : t("llmTestButton")}
            </Button>
            <SettingTip text={t("llmTestHint")} />
            {testResult?.ok && (
              <p className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="size-3.5 shrink-0" />
                {t("llmTestOk", { model: testResult.model })}
              </p>
            )}
            {testResult && !testResult.ok && (
              <p className="flex items-center gap-1.5 text-xs text-destructive">
                <XCircle className="size-3.5 shrink-0" />
                {tRepos(ERROR_KEY[testResult.kind] ?? ERROR_KEY.network)}
              </p>
            )}
          </div>
        </div>

        {/* 本地模型 */}
        <div className="flex flex-col gap-2 border-t pt-4">
          <h3 className="text-xs font-semibold text-muted-foreground">{t("llmLocalTitle")}</h3>
          <p className="text-sm text-muted-foreground">{t("llmLocalDescription")}</p>
        </div>
        <SettingsSaveFooter dirty={dirty} busy={saving} saved={saved} error={saveError} onSave={() => void onSave()} />
      </fieldset>
    </Card>
  );
}
