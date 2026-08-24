"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Check, Circle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

interface LoginFormProps {
  /** setup = 首启设密码（双输入 + 强度提示）；login = 登录（单输入） */
  mode: "setup" | "login";
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

export function LoginForm({ mode }: LoginFormProps) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const lenOk = password.length >= 8;
  const mixOk = /[a-zA-Z]/.test(password) && /\d/.test(password);
  const canSubmit =
    !pending &&
    password.length > 0 &&
    (mode === "login" || (lenOk && password === confirm));

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canSubmit) return;

    setPending(true);
    setError(null);
    try {
      const res = await fetch(
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
          await fetch("/api/v1/auth/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password }),
          }).catch(() => null);
        }
        router.push("/");
        router.refresh();
        return;
      }

      if (res.status === 401) setError("密码错误");
      else if (res.status === 403) setError("管理员已存在，请直接登录");
      else setError("请求失败，请稍后重试");
    } catch {
      setError("网络错误，请检查面板服务后重试");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="password">
            {mode === "setup" ? "管理员密码" : "密码"}
          </Label>
          <Input
            id="password"
            type="password"
            autoComplete={mode === "setup" ? "new-password" : "current-password"}
            placeholder={mode === "setup" ? "设置登录密码" : "输入管理员密码"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            required
          />
          {mode === "setup" && (
            <ul className="flex flex-col gap-1.5 text-xs text-muted-foreground">
              <StrengthHint ok={lenOk}>长度至少 8 位</StrengthHint>
              <StrengthHint ok={mixOk}>建议同时包含字母与数字</StrengthHint>
            </ul>
          )}
        </div>

        {mode === "setup" && (
          <div className="flex flex-col gap-2">
            <Label htmlFor="confirm">确认密码</Label>
            <Input
              id="confirm"
              type="password"
              autoComplete="new-password"
              placeholder="再输入一次"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              aria-invalid={confirm.length > 0 && password !== confirm}
              required
            />
            {confirm.length > 0 && password !== confirm && (
              <p className="text-xs text-destructive">两次输入的密码不一致</p>
            )}
          </div>
        )}
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <Button type="submit" disabled={!canSubmit} className="w-full">
        {pending ? "提交中…" : mode === "setup" ? "保存并进入" : "登录"}
      </Button>
    </form>
  );
}
