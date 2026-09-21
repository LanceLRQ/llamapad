"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";

import { CopyCurlButton } from "@/components/copy-curl-button";
import { ModelEndpointActions } from "@/components/model-endpoint-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { RuntimeCardActions } from "./runtime-card-actions";

/** 与 server/modelsView.ts 的 RunningModelView 同构（客户端不引 server 模块） */
export interface RunningEntry {
  model: string;
  displayName: string;
  container: string;
  startedAt: string | null;
  hostPort: number | null;
  configuredHostPort: number | null;
}

/**
 * 首页「正在运行」区（2026-09-21 设计 §3.2）：每个运行中模型一张卡、横向平铺
 * （运行中通常 1–3 个，铺一行信息给得最足）。概览页那张卡已精简为两行摘要并
 * 引流到这里，两边形态不同，刻意不共享组件——共享只会退化成一堆开关参数。
 */
export function HomeRunning({
  models,
  defaultModel,
}: {
  models: RunningEntry[];
  defaultModel: string | null;
}) {
  const t = useTranslations("pages.modelsHome");
  const format = useFormatter();

  return (
    <section className="px-7 pb-6">
      <h2 className="mb-3 text-sm font-semibold">{t("runningTitle")}</h2>
      {models.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center gap-3 py-12 text-center">
            <p className="text-sm font-medium">{t("runningEmptyTitle")}</p>
            <p className="max-w-md text-sm text-muted-foreground">{t("runningEmptyHint")}</p>
            <Button size="sm" nativeButton={false} render={<Link href="/models/profiles" />}>
              {t("gotoProfiles")}
              <ArrowRight className="size-3.5" />
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
          {models.map((entry) => {
            const isDefault = entry.model === defaultModel;
            return (
              <Card key={entry.model}>
                <CardContent className="flex flex-col gap-3">
                  <div>
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-mono text-lg leading-tight font-bold">
                        {entry.displayName}
                      </span>
                      {isDefault && models.length > 1 && (
                        <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[10px]">
                          {t("defaultBadge")}
                        </Badge>
                      )}
                    </div>
                    <div className="text-[13px] text-muted-foreground">{entry.model}</div>
                  </div>

                  <dl className="flex flex-col gap-1.5 text-xs">
                    <div className="flex items-center justify-between gap-3">
                      <dt className="shrink-0 text-muted-foreground">{t("fieldContainer")}</dt>
                      <dd className="truncate font-mono" title={entry.container}>
                        {entry.container}
                      </dd>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <dt className="shrink-0 text-muted-foreground">{t("fieldPort")}</dt>
                      <dd className="flex items-center gap-0.5 font-mono tabular-nums">
                        {entry.hostPort !== null ? `:${entry.hostPort}` : "—"}
                        {entry.hostPort !== null && (
                          <>
                            <CopyCurlButton hostPort={entry.hostPort} size="icon" />
                            <ModelEndpointActions hostPort={entry.hostPort} />
                          </>
                        )}
                      </dd>
                    </div>
                    {/* 首页运行区是「管模型」的详细视图，端口是否被顺延正是用户要在这里
                        搞清楚的事——脚本或第三方工具可能硬编码了配置里那个端口，顺延后
                        打过去会连不上，这条提示只在这个详细视图里出现是合理的 */}
                    {entry.hostPort !== null &&
                      entry.configuredHostPort !== null &&
                      entry.hostPort !== entry.configuredHostPort && (
                        <div className="text-right text-[11px] text-muted-foreground">
                          {t("portShifted", { port: entry.configuredHostPort })}
                        </div>
                      )}
                    <div className="flex items-center justify-between gap-3">
                      <dt className="shrink-0 text-muted-foreground">{t("fieldStartedAt")}</dt>
                      <dd className="tabular-nums">
                        {entry.startedAt
                          ? format.dateTime(new Date(entry.startedAt), {
                              month: "2-digit",
                              day: "2-digit",
                              hour: "2-digit",
                              minute: "2-digit",
                              hour12: false,
                            })
                          : "—"}
                      </dd>
                    </div>
                  </dl>

                  <RuntimeCardActions
                    modelName={entry.model}
                    displayName={entry.displayName}
                    isDefault={isDefault}
                    showSetDefault={models.length > 1}
                  />
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </section>
  );
}
