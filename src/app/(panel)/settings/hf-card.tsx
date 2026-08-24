"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  CheckCircle2,
  CloudDownload,
  Loader2,
  Save,
  Trash2,
  XCircle,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * 设置页「下载源（Hugging Face）」区块（M2 Task 9，client）：
 * - Token：password 输入 + 保存/清除（PUT /api/v1/settings/hf 的 token 字段）；
 *   状态徽标区分来源——env 只读（环境变量优先生效，改库前需先清 env）、db 可写、
 *   未设置；明文不回显，只显尾 4 位
 * - 镜像：Select（官方 / hf-mirror.com / 自定义 URL），保存调 PUT hfMirror
 * - 代理：panel.yaml 的 proxy 只读展示（改代理需改配置文件重启）
 * - 测试连接：POST /api/v1/settings/hf/test 用当前生效配置调 whoAmI，
 *   成功（含匿名可达）/失败行内提示
 *
 * 初值（快照）由 server 侧装配传入；每次写操作成功后用响应里的新快照就地
 * 更新 + router.refresh()（与命名空间区块的实时性策略一致）。
 */

/** 快照形状（与 GET /api/v1/settings/hf 响应及 server/hf/settings.ts 同构，客户端不引 server 模块） */
export interface HfSettingsSnapshotView {
  tokenSource: "env" | "db" | null;
  tokenSet: boolean;
  tokenTail: string | null;
  hfMirror: string;
  proxy: string | null;
}

/** 测试连接结果（POST /test 的两种响应形状） */
type TestResult =
  | { ok: true; account: string; mirrorUsed: string; viaProxy: boolean }
  | { ok: false; error: string };

/** 镜像 Select 的三档：official/内置镜像归一化，其余值视为自定义 */
const HF_MIRROR_PRESET = "https://hf-mirror.com";
type MirrorChoice = "official" | "preset" | "custom";

function mirrorToChoice(mirror: string): MirrorChoice {
  if (mirror === "official") return "official";
  if (mirror === HF_MIRROR_PRESET) return "preset";
  return "custom";
}

export function HfCard({ initial }: { initial: HfSettingsSnapshotView }) {
  const t = useTranslations("pages.settings");
  const router = useRouter();

  const [snap, setSnap] = useState(initial);

  // Token 表单
  const [tokenDraft, setTokenDraft] = useState("");
  const [tokenBusy, setTokenBusy] = useState<"save" | "clear" | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);

  // 镜像表单
  const [choice, setChoice] = useState<MirrorChoice>(mirrorToChoice(initial.hfMirror));
  const [customUrl, setCustomUrl] = useState(mirrorToChoice(initial.hfMirror) === "custom" ? initial.hfMirror : "");
  const [mirrorBusy, setMirrorBusy] = useState(false);
  const [mirrorError, setMirrorError] = useState<string | null>(null);

  // 测试连接
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  /** PUT 快照接口的统一封装：成功更新本地快照并刷新 SSR 数据，失败回显 error */
  async function putSettings(body: Record<string, unknown>): Promise<boolean> {
    const res = await fetch("/api/v1/settings/hf", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    if (res === null) {
      setTokenError(t("errorNetwork"));
      setMirrorError(t("errorNetwork"));
      return false;
    }
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      setTokenError(data?.error ?? t("errorRequest"));
      setMirrorError(data?.error ?? t("errorRequest"));
      return false;
    }
    setSnap((await res.json()) as HfSettingsSnapshotView);
    router.refresh();
    return true;
  }

  async function onSaveToken() {
    if (tokenBusy !== null || tokenDraft.trim() === "" || snap.tokenSource === "env") return;
    setTokenBusy("save");
    setTokenError(null);
    const okDone = await putSettings({ token: tokenDraft.trim() });
    setTokenBusy(null);
    if (okDone) setTokenDraft("");
  }

  async function onClearToken() {
    if (tokenBusy !== null || snap.tokenSource !== "db") return;
    setTokenBusy("clear");
    setTokenError(null);
    await putSettings({ token: null });
    setTokenBusy(null);
  }

  async function onSaveMirror() {
    if (mirrorBusy) return;
    const value = choice === "official" ? "official" : choice === "preset" ? HF_MIRROR_PRESET : customUrl.trim();
    if (value === "") return;
    setMirrorBusy(true);
    setMirrorError(null);
    await putSettings({ hfMirror: value });
    setMirrorBusy(false);
  }

  async function onTest() {
    if (testing) return;
    setTesting(true);
    setTestResult(null);
    const res = await fetch("/api/v1/settings/hf/test", { method: "POST" }).catch(() => null);
    setTesting(false);
    if (res === null) {
      setTestResult({ ok: false, error: t("errorNetwork") });
      return;
    }
    const data = (await res.json().catch(() => null)) as TestResult | null;
    if (data === null) {
      setTestResult({ ok: false, error: t("errorRequest") });
      return;
    }
    setTestResult(data);
  }

  /** 选择镜像档位时清掉上一档遗留的错误提示 */
  function onChoiceChange(next: MirrorChoice) {
    setChoice(next);
    setMirrorError(null);
  }

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2.5 border-b px-4 py-3">
        <CloudDownload className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">{t("hfTitle")}</h2>
        <span className="text-xs text-muted-foreground">{t("hfDescription")}</span>
      </div>

      <div className="flex flex-col gap-5 px-4 py-3.5">
        {/* 访问令牌 */}
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Label className="text-xs text-muted-foreground">{t("hfTokenLabel")}</Label>
            {snap.tokenSource === "env" && <Badge variant="outline">{t("hfSourceEnv")}</Badge>}
            {snap.tokenSource === "db" && <Badge variant="secondary">{t("hfSourceDb")}</Badge>}
            {snap.tokenSource === null && (
              <span className="text-xs text-muted-foreground">{t("hfSourceNone")}</span>
            )}
            <span className="font-mono text-xs text-muted-foreground">
              {snap.tokenTail ? `····${snap.tokenTail}` : t("hfTokenTailNone")}
            </span>
          </div>
          <div className="flex max-w-xl items-center gap-2">
            <Input
              className="font-mono"
              type="password"
              autoComplete="off"
              placeholder={t("hfTokenPlaceholder")}
              value={tokenDraft}
              disabled={snap.tokenSource === "env"}
              onChange={(e) => setTokenDraft(e.target.value)}
              aria-invalid={tokenError !== undefined}
              onKeyDown={(e) => {
                if (e.key === "Enter") onSaveToken();
              }}
            />
            <Button
              size="sm"
              disabled={tokenBusy !== null || tokenDraft.trim() === "" || snap.tokenSource === "env"}
              onClick={onSaveToken}
            >
              {tokenBusy === "save" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Save className="size-3.5" />
              )}
              {tokenBusy === "save" ? t("hfTokenSaving") : t("hfTokenSaveButton")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={tokenBusy !== null || snap.tokenSource !== "db"}
              onClick={onClearToken}
            >
              {tokenBusy === "clear" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Trash2 className="size-3.5" />
              )}
              {tokenBusy === "clear" ? t("hfTokenClearing") : t("hfTokenClearButton")}
            </Button>
          </div>
          {snap.tokenSource === "env" && (
            <p className="text-xs text-muted-foreground">{t("hfSourceEnvHint")}</p>
          )}
          {tokenError && <p className="text-xs text-destructive">{tokenError}</p>}
        </div>

        {/* 镜像源 */}
        <div className="flex flex-col gap-2 border-t pt-4">
          <Label className="text-xs text-muted-foreground">{t("hfMirrorLabel")}</Label>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={choice} onValueChange={(v) => onChoiceChange(v as MirrorChoice)}>
              <SelectTrigger size="sm" className="w-56">
                <SelectValue>
                  {choice === "official"
                    ? t("hfMirrorOfficial")
                    : choice === "preset"
                      ? t("hfMirrorPreset")
                      : t("hfMirrorCustom")}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="official">{t("hfMirrorOfficial")}</SelectItem>
                <SelectItem value="preset">{t("hfMirrorPreset")}</SelectItem>
                <SelectItem value="custom">{t("hfMirrorCustom")}</SelectItem>
              </SelectContent>
            </Select>
            {choice === "custom" && (
              <Input
                className="max-w-xs font-mono"
                placeholder={t("hfMirrorCustomPlaceholder")}
                value={customUrl}
                onChange={(e) => setCustomUrl(e.target.value)}
                aria-invalid={mirrorError !== undefined}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onSaveMirror();
                }}
              />
            )}
            <Button
              size="sm"
              disabled={mirrorBusy || (choice === "custom" && customUrl.trim() === "")}
              onClick={onSaveMirror}
            >
              {mirrorBusy ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Save className="size-3.5" />
              )}
              {mirrorBusy ? t("hfMirrorSaving") : t("hfMirrorSaveButton")}
            </Button>
          </div>
          {mirrorError && <p className="text-xs text-destructive">{mirrorError}</p>}
        </div>

        {/* 出站代理（只读） */}
        <div className="flex flex-col gap-2 border-t pt-4">
          <Label className="text-xs text-muted-foreground">{t("hfProxyLabel")}</Label>
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="font-mono text-sm">
              {snap.proxy ?? <span className="text-muted-foreground">{t("hfProxyNone")}</span>}
            </span>
            <span className="text-xs text-muted-foreground">{t("hfProxyFrom")}</span>
          </div>
        </div>

        {/* 测试连接 */}
        <div className="flex flex-col gap-2 border-t pt-4">
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="outline" size="sm" disabled={testing} onClick={onTest}>
              {testing ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <CheckCircle2 className="size-3.5" />
              )}
              {testing ? t("hfTesting") : t("hfTestButton")}
            </Button>
            {testResult?.ok && (
              <p className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="size-3.5 shrink-0" />
                {t("hfTestOk", { account: testResult.account, mirror: testResult.mirrorUsed })}
                {testResult.viaProxy ? t("hfTestViaProxy") : t("hfTestDirect")}
              </p>
            )}
            {testResult && !testResult.ok && (
              <p className="flex items-center gap-1.5 text-xs text-destructive">
                <XCircle className="size-3.5 shrink-0" />
                {t("hfTestFail", { error: testResult.error })}
              </p>
            )}
          </div>
          <p className="text-xs text-muted-foreground">{t("hfTestHint")}</p>
        </div>
      </div>
    </Card>
  );
}
