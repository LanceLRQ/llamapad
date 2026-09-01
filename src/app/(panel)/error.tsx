"use client";

import { useEffect } from "react";
import { TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";

/**
 * 面板路由组的客户端错误边界（Next 16 file convention：wrap page.tsx/嵌套
 * layout.tsx，不 wrap 本目录的 layout.tsx，故侧栏/状态栏仍在，只有内容区
 * 换成本组件）。
 *
 * 补它的直接动机：真机上 webhooks-card.tsx 的 crypto.randomUUID 在 HTTP 局域网
 * 下抛出 TypeError 时，因为项目原本没有任何 error.tsx，异常被 Next 内置兜底页
 * 接管，只显示一句 "This page couldn't load"——错误信息被完全吞掉，这个 bug
 * 因此被误判成"功能没做"。有了这层边界，同类未预见的客户端异常至少能看到
 * error.message，不必每次都翻服务器日志或源码去猜。
 */
export default function PanelError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const t = useTranslations("common");

  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-center">
      <TriangleAlert className="size-8 text-destructive" />
      <h2 className="text-sm font-semibold">{t("errorBoundaryTitle")}</h2>
      {error.message && (
        <p className="max-w-md text-xs break-words text-muted-foreground">{error.message}</p>
      )}
      <Button size="sm" onClick={() => retry()}>
        {t("errorBoundaryRetry")}
      </Button>
    </div>
  );
}
