"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Check, Circle, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { apiFetch } from "@/lib/api";
import { classifyLoginError } from "@/lib/login-error";

interface LoginFormProps {
  /** setup = 首启设密码（双输入 + 强度提示）；login = 登录（单输入） */
  mode: "setup" | "login";
  /** 会话过期跳转带来的回跳目标（已 sanitize，站内路径）；无则回 "/" */
  nextPath?: string | null;
  /** 会话过期标记（expired=1）：登录框上方给琥珀提示 */
  expired?: boolean;
}

function StrengthHint({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-1.5">
      {ok ? (
        <Check className="size-3.5 shrink-0 text-accent-green" />
      ) : (
        <Circle className="size-3.5 shrink-0 opacity-40" />
      )}
      <span className={cn(ok && "text-foreground")}>{children}</span>
    </li>
  );
}

export function LoginForm({ mode, nextPath, expired }: LoginFormProps) {
  const t = useTranslations("login");
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  // 密码错误（登录失败）：单字段问题，输入框描红 + 一行小字
  const [fieldError, setFieldError] = useState(false);
  // 其它失败（管理员已存在 / 请求失败 / 网络错误）：整块警告
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const lenOk = password.length >= 8;
  const mixOk = /[a-zA-Z]/.test(password) && /\d/.test(password);
  const mismatch = mode === "setup" && confirm.length > 0 && password !== confirm;
  const canSubmit =
    !pending &&
    password.length > 0 &&
    (mode === "login" || (lenOk && password === confirm));

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canSubmit) return;

    setPending(true);
    setError(null);
    setFieldError(false);
    try {
      const res = await apiFetch(
        mode === "setup" ? "/api/v1/auth/setup" : "/api/v1/auth/login",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password }),
        },
      );

      if (res.ok) {
        // setup 只建管理员不签 session：紧跟一次 login 换 cookie，再进面板；
        // 换取失败也无妨——会被 (panel)/layout 重定向回 /login 走正常登录
        if (mode === "setup") {
          await apiFetch("/api/v1/auth/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password }),
          }).catch(() => null);
        }
        router.push(nextPath ?? "/");
        router.refresh();
        return;
      }

      if (classifyLoginError(mode, res.status) === "field") setFieldError(true);
      else if (res.status === 403) setError(t("adminExists"));
      else setError(t("requestFailed"));
    } catch {
      setError(t("networkError"));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
      {expired && mode === "login" && (
        <p className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          {t("sessionExpired")}
        </p>
      )}
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="password">
            {mode === "setup" ? t("adminPassword") : t("password")}
          </Label>
          <Input
            id="password"
            type="password"
            autoComplete={mode === "setup" ? "new-password" : "current-password"}
            placeholder={mode === "setup" ? t("setupPasswordPlaceholder") : t("passwordPlaceholder")}
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              if (fieldError) setFieldError(false);
            }}
            aria-invalid={fieldError}
            autoFocus
            required
          />
          {mode === "setup" && (
            <ul className="flex flex-col gap-1.5 text-xs text-muted-foreground">
              <StrengthHint ok={lenOk}>{t("ruleLength")}</StrengthHint>
              <StrengthHint ok={mixOk}>{t("ruleMix")}</StrengthHint>
            </ul>
          )}
          {fieldError && <p className="text-xs text-destructive">{t("wrongPassword")}</p>}
        </div>

        {mode === "setup" && (
          <div className="flex flex-col gap-2">
            <Label htmlFor="confirm">{t("confirmPassword")}</Label>
            <Input
              id="confirm"
              type="password"
              autoComplete="new-password"
              placeholder={t("confirmPlaceholder")}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              aria-invalid={mismatch}
              required
            />
          </div>
        )}
      </div>

      {mismatch && (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span>{t("mismatch")}</span>
        </div>
      )}

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <Button type="submit" disabled={!canSubmit} className="w-full">
        {pending ? t("submitting") : mode === "setup" ? t("submitSetup") : t("submitLogin")}
      </Button>
    </form>
  );
}
