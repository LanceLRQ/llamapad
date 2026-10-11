"use client";

import { useRef } from "react";
import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  buildModelNameGroups,
  type ModelNameRow,
  type ModelNameServiceInput,
  type ModelNameStatus,
  type ModelNameUpstreamInput,
} from "@/lib/relay-model-names";
import { cn } from "@/lib/utils";
import { CopyButton } from "./copy-field";

const DOT_STYLES: Record<ModelNameStatus, string> = {
  ready: "bg-accent-green",
  reachable: "bg-accent-green",
  loading: "bg-primary",
  unreachable: "bg-destructive",
  unknown: "bg-muted-foreground/50",
};

/** 状态 → 圆点提示文案（pages.relay 下的键） */
const STATUS_KEYS: Record<ModelNameStatus, string> = {
  ready: "managed.ready",
  loading: "managed.loading",
  reachable: "upstreams.stateReachable",
  unreachable: "upstreams.stateUnreachable",
  unknown: "upstreams.stateUnknown",
};

function NameRowItem({ row }: { row: ModelNameRow }) {
  const t = useTranslations("pages.relay");
  const copyRef = useRef<HTMLButtonElement>(null);
  const isAlias = row.kind === "alias";
  const statusText = t(STATUS_KEYS[row.status]);

  // 整行点击复制：转交给行内的复制按钮，复制逻辑与「已复制」反馈只有一份
  return (
    <div
      className={cn(
        "grid cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-muted",
        isAlias ? "ml-4 grid-cols-[minmax(0,1fr)_auto]" : "grid-cols-[8px_minmax(0,1fr)_auto]",
      )}
      title={isAlias ? undefined : `${row.title} · ${statusText}`}
      onClick={() => copyRef.current?.click()}
    >
      {!isAlias && <span className={cn("size-2 rounded-full", DOT_STYLES[row.status])} title={statusText} />}
      <span className="min-w-0 leading-snug">
        <span className="font-mono text-[13px] [overflow-wrap:anywhere]">{row.name}</span>
        {row.isDefault && (
          <Badge variant="outline" className="ml-1.5 h-4.5 px-1.5 align-[1px] text-[11px]">
            {t("managed.default")}
          </Badge>
        )}
        {row.forwardsTo !== null && isAlias && (
          <span className="block font-mono text-xs [overflow-wrap:anywhere] text-muted-foreground">
            → {row.forwardsTo}
          </span>
        )}
      </span>
      <CopyButton ref={copyRef} value={row.name} />
    </div>
  );
}

function Group({ title, count, rows }: { title: string; count: number; rows: ModelNameRow[] }) {
  return (
    <div className="mt-2 flex flex-col gap-0.5 border-t pt-2 first:mt-0 first:border-t-0 first:pt-0">
      <div className="flex justify-between px-1.5 text-xs font-semibold text-muted-foreground">
        <span>{title}</span>
        <span>{count}</span>
      </div>
      {rows.map((row) => (
        <NameRowItem key={`${row.kind}:${row.name}`} row={row} />
      ))}
    </div>
  );
}

/**
 * 右侧栏的「可用模型名」：此刻能写进请求 model 字段的全部名字，分托管 / 外部上游两组。
 * 数据整理见 lib/relay-model-names.ts；上游列表由外层持有并轮询，这里只读。
 * 卡片标题不滚，列表区自己滚。
 */
export function ModelNamesCard({
  services,
  upstreams,
  managedDefault,
}: {
  services: ModelNameServiceInput[];
  upstreams: ModelNameUpstreamInput[];
  managedDefault: string | null;
}) {
  const t = useTranslations("pages.relay.names");
  const groups = buildModelNameGroups({ services, upstreams, managedDefault });
  const empty = groups.managed.count === 0 && groups.external.count === 0;

  return (
    <Card className="min-h-40 gap-0 py-3 xl:flex-1">
      <div className="px-3">
        <h2 className="text-sm font-semibold">{t("title")}</h2>
        <p className="mt-px mb-2 text-xs text-muted-foreground">{t("hint")}</p>
      </div>
      {/* scrollbar-gutter 常驻留出滚动条的位置、左右内边距对称：滚动条常显的系统上不压内容、不贴卡片边 */}
      <div className="min-h-0 flex-1 px-3 [scrollbar-gutter:stable] xl:overflow-y-auto">
        {empty ? (
          <p className="py-4 text-center text-xs text-muted-foreground">{t("empty")}</p>
        ) : (
          <>
            {groups.managed.count > 0 && (
              <Group title={t("groupManaged")} count={groups.managed.count} rows={groups.managed.rows} />
            )}
            {groups.external.count > 0 && (
              <Group title={t("groupExternal")} count={groups.external.count} rows={groups.external.rows} />
            )}
          </>
        )}
      </div>
    </Card>
  );
}
