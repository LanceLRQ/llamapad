"use client";

import Link from "next/link";
import { Archive, ArrowRight } from "lucide-react";
import { useTranslations } from "next-intl";

import { RepoCard, type RepoProfileEntry } from "@/components/repo-card";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

/**
 * 首页「最近更新的仓库」区（2026-09-21 设计 §3.3）：只列最近更新的几个，
 * 全量在 /models/repos。排序与截断已由 server 侧 pickRecentRepos 做完，
 * 本组件只负责渲染，不再自己排一遍。
 */
export function HomeRepos({ repos, total }: { repos: RepoProfileEntry[]; total: number }) {
  const t = useTranslations("pages.modelsHome");
  const tRepos = useTranslations("pages.repos");

  return (
    <section className="px-7 pb-6">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{t("reposTitle")}</h2>
        {total > 0 && (
          <Button variant="ghost" size="sm" nativeButton={false} render={<Link href="/models/repos" />}>
            {t("reposViewAll", { total })}
            <ArrowRight className="size-3.5" />
          </Button>
        )}
      </div>
      {repos.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-3 py-12 text-center">
            <span className="flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
              <Archive className="size-6" />
            </span>
            <p className="text-sm font-medium">{tRepos("emptyTitle")}</p>
            <p className="max-w-md text-sm text-muted-foreground">{tRepos("emptyDescription")}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {repos.map((profile) => (
            <RepoCard key={profile.id} profile={profile} />
          ))}
        </div>
      )}
    </section>
  );
}
