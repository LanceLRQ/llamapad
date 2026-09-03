"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { CheckCircle2, Loader2, Save, Sparkles, Trash2, XCircle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch } from "@/lib/api";
import { isValidExtraBody } from "@/lib/llm-extra-body";
import { SettingTip } from "@/components/setting-tip";
import { toast } from "@/components/toast-store";

/**
 * 设置页「LLM 解析引擎」区块（README-LLM 解析批 3 任务 17，client；
 * 引擎现选改造后本卡只管外部 API 怎么连——「用哪个引擎」挪去了仓库详情页
 * 的 AI 解析卡，见 llm-extract-panel.tsx，不再有全局的三选一）：
 * - 外部 API：Base URL / API Key / 模型 / 额外请求体 各自独立输入 + 保存，
 *   形态照抄 hf-card.tsx 的 Token/Mirror/Proxy 三段——env 来源的字段禁用输入
 *   并标注来源（Badge 用短键 `llmFromEnv`，下方长句提示用 `llmFromEnvHint`，
 *   拆两个键是照 hf-card.tsx 的双层设计，一个键身兼两职会让 Badge 撑坏或
 *   提示句敷衍），API Key 已保存时只显尾 4 位 + 更换/清除，明文永不回显、
 *   取消/清除都会把 draft 一并清空（否则反悔过的明文会在下次编辑态原样回显）。
 *   额外请求体（透传 provider 专属字段，如智谱 `thinking` 关闭推理省 86 倍
 *   token）放进原生 `<details>`（本仓无 Collapsible 组件），失焦校验复用
 *   `lib/llm-extra-body.ts` 的 `isValidExtraBody`（与服务端同一份"合法 JSON
 *   且顶层是对象"口径），不阻止保存——服务端也会校验
 * - 测试连接：POST /api/v1/settings/llm/test，失败按 kind 复用
 *   `pages.repos` 的 `llmError.*` 那组键（与 llm-extract-panel.tsx 同一张
 *   映射表），成功显示模型名
 * - 本地模型：纯说明文字，引导去仓库详情页的 AI 解析卡直接选正在运行的模型
 *
 * 初值（快照）由 server 侧装配传入；每次写操作成功后直接用响应体替换本地
 * 快照 + router.refresh()（与 HF 卡的实时性策略一致），保存成功另弹一次
 * toast——五个保存处理器此前只在失败时有反馈，用户不知道成没成。
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

  // Base URL
  const [baseUrlDraft, setBaseUrlDraft] = useState(initial.baseUrl ?? "");
  const [baseUrlBusy, setBaseUrlBusy] = useState(false);
  const [baseUrlError, setBaseUrlError] = useState<string | null>(null);

  // API Key：已保存时先显示尾 4 位，点「更换」才切成可输入状态——与 HF Token 同语义，明文不回显、不预填
  const [keyEditing, setKeyEditing] = useState(!initial.keySet);
  const [keyDraft, setKeyDraft] = useState("");
  const [keyBusy, setKeyBusy] = useState<"save" | "clear" | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);

  // 模型
  const [modelDraft, setModelDraft] = useState(initial.model ?? "");
  const [modelBusy, setModelBusy] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);

  // 额外请求体
  const [extraBodyDraft, setExtraBodyDraft] = useState(initial.extraBody ?? "");
  const [extraBodyBusy, setExtraBodyBusy] = useState(false);
  const [extraBodyError, setExtraBodyError] = useState<string | null>(null);
  const [extraBodyInvalid, setExtraBodyInvalid] = useState(false);

  // 测试连接
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  /** PUT 快照接口的统一封装：成功更新本地快照 + 刷新 SSR 数据 + 弹一次成功
   *  toast（五个保存处理器共用这一处，不必各自重复），失败把消息交回调用方，
   *  由各字段自己的错误状态展示——不像 hf-card 那样广播到全部表单（本卡字段更多，
   *  一次失败没理由让另外四组字段一起冒红）。
   *
   *  PUT 响应形状就是完整的 `getLlmSettings()` 快照，直接整份替换即可——
   *  引擎现选改造后快照里已经没有需要跨请求沿用的字段了。 */
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
    router.refresh();
    toast.success(t("llmSaveDone"));
    return { ok: true };
  }

  async function onSaveBaseUrl() {
    if (baseUrlBusy || snap.baseUrlSource === "env") return;
    setBaseUrlBusy(true);
    setBaseUrlError(null);
    const value = baseUrlDraft.trim();
    const result = await putSettings({ baseUrl: value === "" ? null : value });
    setBaseUrlBusy(false);
    if (!result.ok) setBaseUrlError(result.message);
  }

  async function onSaveKey() {
    if (keyBusy !== null || keyDraft.trim() === "" || snap.keySource === "env") return;
    setKeyBusy("save");
    setKeyError(null);
    const result = await putSettings({ apiKey: keyDraft.trim() });
    setKeyBusy(null);
    if (result.ok) {
      setKeyDraft("");
      setKeyEditing(false);
    } else {
      setKeyError(result.message);
    }
  }

  async function onClearKey() {
    if (keyBusy !== null || snap.keySource !== "db") return;
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

  async function onSaveModel() {
    if (modelBusy || snap.modelSource === "env") return;
    setModelBusy(true);
    setModelError(null);
    const value = modelDraft.trim();
    const result = await putSettings({ model: value === "" ? null : value });
    setModelBusy(false);
    if (!result.ok) setModelError(result.message);
  }

  function onExtraBodyBlur() {
    // 校验口径必须与服务端（PUT 路由）一致——不能只查"是合法 JSON"，还要求顶层
    // 是非数组对象，否则 [1,2,3] 这类合法 JSON 但非对象的输入不会红框、点保存
    // 才被服务端拒绝，早期反馈就失效了。判定下沉 lib，与 parseExtraBody 同一份口径
    setExtraBodyInvalid(!isValidExtraBody(extraBodyDraft));
  }

  async function onSaveExtraBody() {
    if (extraBodyBusy || snap.extraBodySource === "env") return;
    setExtraBodyBusy(true);
    setExtraBodyError(null);
    // 非法 JSON 不阻止保存——服务端也会校验，这里只是早一点告诉用户
    const result = await putSettings({ extraBody: extraBodyDraft.trim() });
    setExtraBodyBusy(false);
    if (!result.ok) setExtraBodyError(result.message);
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

  return (
    <Card className="gap-0 py-0">
      <div className="flex flex-wrap items-center gap-2.5 border-b p-4">
        <Sparkles className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">{t("llmTitle")}</h2>
      </div>

      <div className="flex flex-col gap-5 p-4">
        {/* 外部 API */}
        <div className="flex flex-col gap-4 border-t pt-4">
          <h3 className="text-xs font-semibold text-muted-foreground">{t("llmExternalTitle")}</h3>

          {/* Base URL */}
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Label className="text-xs text-muted-foreground">{t("llmBaseUrlLabel")}</Label>
              {snap.baseUrlSource === "env" && <Badge variant="outline">{t("llmFromEnv")}</Badge>}
            </div>
            <div className="flex max-w-xl items-center gap-2">
              <Input
                className="font-mono"
                autoComplete="off"
                placeholder={t("llmBaseUrlPlaceholder")}
                value={baseUrlDraft}
                disabled={snap.baseUrlSource === "env"}
                onChange={(e) => setBaseUrlDraft(e.target.value)}
                aria-invalid={baseUrlError !== null}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onSaveBaseUrl();
                }}
              />
              <Button
                size="sm"
                disabled={baseUrlBusy || snap.baseUrlSource === "env"}
                onClick={onSaveBaseUrl}
              >
                {baseUrlBusy ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Save className="size-3.5" />
                )}
                {baseUrlBusy ? t("llmBaseUrlSaving") : t("llmBaseUrlSaveButton")}
              </Button>
            </div>
            {snap.baseUrlSource === "env" && <p className="text-sm text-foreground">{t("llmFromEnvHint")}</p>}
            {baseUrlError && <p className="text-xs text-destructive">{baseUrlError}</p>}
          </div>

          {/* API Key */}
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Label className="text-xs text-muted-foreground">{t("llmApiKeyLabel")}</Label>
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
                <Button variant="outline" size="sm" disabled={keyBusy !== null} onClick={onClearKey}>
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
                  value={keyDraft}
                  onChange={(e) => setKeyDraft(e.target.value)}
                  aria-invalid={keyError !== null}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onSaveKey();
                  }}
                />
                <Button size="sm" disabled={keyBusy !== null || keyDraft.trim() === ""} onClick={onSaveKey}>
                  {keyBusy === "save" ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Save className="size-3.5" />
                  )}
                  {keyBusy === "save" ? t("llmApiKeySaving") : t("llmApiKeySaveButton")}
                </Button>
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
              <Label className="text-xs text-muted-foreground">{t("llmModelLabel")}</Label>
              {snap.modelSource === "env" && <Badge variant="outline">{t("llmFromEnv")}</Badge>}
            </div>
            <div className="flex max-w-xl items-center gap-2">
              <Input
                className="font-mono"
                autoComplete="off"
                placeholder={t("llmModelPlaceholder")}
                value={modelDraft}
                disabled={snap.modelSource === "env"}
                onChange={(e) => setModelDraft(e.target.value)}
                aria-invalid={modelError !== null}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onSaveModel();
                }}
              />
              <Button size="sm" disabled={modelBusy || snap.modelSource === "env"} onClick={onSaveModel}>
                {modelBusy ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Save className="size-3.5" />
                )}
                {modelBusy ? t("llmModelSaving") : t("llmModelSaveButton")}
              </Button>
            </div>
            {snap.modelSource === "env" && <p className="text-sm text-foreground">{t("llmFromEnvHint")}</p>}
            {modelError && <p className="text-xs text-destructive">{modelError}</p>}
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
                aria-invalid={extraBodyInvalid || extraBodyError !== null}
              />
              {extraBodyInvalid && <p className="text-xs text-destructive">{t("llmExtraBodyInvalid")}</p>}
              <Button
                size="sm"
                className="self-start"
                disabled={extraBodyBusy || snap.extraBodySource === "env"}
                onClick={onSaveExtraBody}
              >
                {extraBodyBusy ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Save className="size-3.5" />
                )}
                {extraBodyBusy ? t("llmExtraBodySaving") : t("llmExtraBodySaveButton")}
              </Button>
              {extraBodyError && <p className="text-xs text-destructive">{extraBodyError}</p>}
            </div>
          </details>

          {/* 测试连接 */}
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="outline" size="sm" disabled={testing} onClick={onTest}>
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
      </div>
    </Card>
  );
}
