import { Fragment } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { breadcrumbSegments } from "@/lib/files-tree";

/**
 * 文件页面包屑（阶段 3b C3）：`models / qwen3.6 / 70b`，每段可点，最后一段
 * 是当前目录不可点（纯文本）。纯展示 + 普通链接跳转，不需要任何客户端状态
 * （选中态整个走 URL），所以是 server component——不用为一段面包屑多打
 * 一份客户端 JS。
 *
 * 根节点固定叫 "models"、链接到 `?path=`（显式空串，区别于不带 path 的
 * 默认落地页——见 lib/files-view.ts resolveFilesView 对 raw === "" 的
 * 特殊处理），不从 breadcrumbSegments 的返回值里取：那个纯函数只管"路径
 * 分段"，根节点是固定的 UI 常量，让调用方自己拼一次比每次都要从函数结果里
 * 剔除"第一个特殊节点"更直接。
 */
export async function FilesBreadcrumb({ folder }: { folder: string }) {
  const t = await getTranslations("pages.files");
  const segments = breadcrumbSegments(folder);
  const isRoot = folder === "";

  return (
    <nav aria-label={t("breadcrumbLabel")} className="flex min-w-0 items-center gap-1 text-[13px]">
      {isRoot ? (
        <span className="font-mono font-semibold text-foreground">{t("breadcrumbRoot")}</span>
      ) : (
        <Link
          href="/files?path="
          className="font-mono text-muted-foreground transition-colors hover:text-foreground"
        >
          {t("breadcrumbRoot")}
        </Link>
      )}
      {segments.map((segment, i) => {
        const isLast = i === segments.length - 1;
        return (
          <Fragment key={segment.path}>
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/60" />
            {isLast ? (
              <span className="truncate font-mono font-semibold text-foreground">{segment.name}</span>
            ) : (
              <Link
                href={`/files?path=${encodeURIComponent(segment.path)}`}
                className="truncate font-mono text-muted-foreground transition-colors hover:text-foreground"
              >
                {segment.name}
              </Link>
            )}
          </Fragment>
        );
      })}
    </nav>
  );
}
