import { getTranslations } from "next-intl/server";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getDb } from "@/server/db";

import { LoginForm } from "./login-form";

// 读 admins 表（better-sqlite3）→ 动态渲染，禁止 build 期预渲染
export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const t = await getTranslations("login");
  return { title: t("metaTitle") };
}

/** 登录 / 首启页：admins 为空渲染"设置初始密码"，否则渲染"登录" */
export default async function LoginPage() {
  const t = await getTranslations("login");
  const db = getDb();
  const { c } = db.prepare("SELECT COUNT(*) AS c FROM admins").get() as { c: number };
  const needsSetup = c === 0;

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-background px-4 py-10 text-foreground">
      <Card className="w-full max-w-sm">
        <CardHeader className="justify-items-center gap-2 text-center">
          {/* 品牌 mark 占位：与侧栏一致的 amber 渐变方块 + "L" */}
          <span className="mt-2 flex size-11 items-center justify-center rounded-xl bg-gradient-to-br from-amber-400 to-amber-500 font-mono text-lg font-extrabold text-stone-900">
            L
          </span>
          <CardTitle className="text-lg">
            {needsSetup ? t("titleSetup") : t("titleLogin")}
          </CardTitle>
          <CardDescription>
            {needsSetup ? t("subtitleSetup") : t("subtitleLogin")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <LoginForm mode={needsSetup ? "setup" : "login"} />
        </CardContent>
      </Card>
    </div>
  );
}
