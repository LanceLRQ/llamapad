"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";

import type { ServerConfig } from "@/core/schemas";
import { recommendDiff, selectedServer, type DiffRow } from "@/lib/recommend-diff";
import type { ExtractableField, RecommendedProfile } from "@/lib/readme-params";
import { suggestedPresetName } from "@/lib/suggested-preset-name";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";

/** 来源 → 徽章文案键；未收录的来源不渲染徽章而不是抛错——卡片本身仍然可用 */
const SOURCE_BADGE_KEY: Partial<Record<RecommendedProfile["source"], string>> = {
  "cli-block": "recommendSourceCli",
  "kv-list": "recommendSourceKv",
  llm: "recommendSourceLlm",
};

function formatValue(value: unknown): string {
  return String(value);
}

/**
 * 单套「README 官方推荐参数」卡（README 推荐参数抽取 T18）。
 *
 * 复选框状态由本组件持有：采样类默认勾选（模型作者真正懂、与硬件无关），
 * 性能类默认不勾（与用户显存强相关，见 lib/recommend-diff.ts 的取舍说明）。
 * 应用与存为预设都只作用于「当前勾选到的字段」，一个都没勾时两个动作都禁用——
 * 避免用户以为「卡片存在」等于「这些参数已经生效」。
 */
export function RecommendProfileCard({
  profile,
  modelLabel,
  effective,
  repoBaseName,
  onApply,
  onSaveAsPreset,
}: {
  profile: RecommendedProfile;
  /** AI 卡的模型名，显示在来源徽章旁。规则卡不传 */
  modelLabel?: string;
  /** 当前生效的 server 配置（全局默认，档案页没有具体模型上下文） */
  effective: ServerConfig;
  /** 仓库基名（`owner/name` 的 name 部分），用于拼「存为预设」的默认名 */
  repoBaseName: string;
  onApply: (server: Partial<ServerConfig>) => void;
  onSaveAsPreset: (server: Partial<ServerConfig>, suggestedName: string) => void;
}) {
  const t = useTranslations("pages.repos");

  const rows = useMemo(() => recommendDiff(profile.server, effective), [profile.server, effective]);
  const [checked, setChecked] = useState<Set<ExtractableField>>(
    () => new Set(rows.filter((row) => row.defaultChecked).map((row) => row.field)),
  );

  const samplingRows = rows.filter((row) => row.category === "sampling");
  const perfRows = rows.filter((row) => row.category === "perf");
  const nothingSelected = checked.size === 0;

  function toggle(field: ExtractableField, next: boolean): void {
    setChecked((prev) => {
      const set = new Set(prev);
      if (next) set.add(field);
      else set.delete(field);
      return set;
    });
  }

  function currentSelection(): Partial<ServerConfig> {
    return selectedServer(rows, checked);
  }

  const sourceBadgeKey = SOURCE_BADGE_KEY[profile.source];

  return (
    // min-w-0：卡片现在是三列网格里的一个格子（任务 2 由整页宽改窄），网格
    // 项默认 min-width:auto，内容一撑宽（长 label、长参数值）就会把整条
    // 网格 track 顶开、破坏三列布局——这一行是让子元素的 truncate/wrap 真正生效的前提。
    // flex h-96 flex-col：卡片取**死高度**而不是 h-full。h-full 解析的是网格
    // 行高，而行高是 auto——由最高的那张卡的内容决定，所以展开「原文」折叠区
    // 时行会跟着长高，中间区的 overflow-y-auto 永远等不到约束、滚动条不出现
    // （真机反馈）。定死高度后三张卡天然等高，内容超出一律在中间区内部滚动
    <Card className="min-w-0 flex h-96 flex-col">
      {/* 卡头：label + 来源徽章，不参与滚动，一直钉在卡片顶部 */}
      <CardContent className="flex shrink-0 min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 break-words text-sm font-semibold">{profile.label || t("recommendUnnamed")}</span>
        {sourceBadgeKey !== undefined && (
          <Badge variant="outline" className="font-normal">
            {t(sourceBadgeKey)}
          </Badge>
        )}
        {modelLabel !== undefined && (
          <span className="text-[11px] text-muted-foreground">· {modelLabel}</span>
        )}
      </CardContent>

      {/* 中间内容区吃掉卡片剩下的全部高度并在内部滚动。`min-h-0` 是必需的：
          flex 子项的 min-height 默认是 auto（等于内容高度），不显式归零的话
          它压根不会收缩到容器高度以下，overflow-y-auto 就是摆设。卡头与底部
          按钮区都是 shrink-0，所以这里的高度 = 卡片死高度 − 那两块，卡头因
          长 label 多占一行时中间区自动少一行，不会在按钮上方留缝。原有的
          chip 换行、min-w-0、truncate 等窄卡适配全部保留 */}
      <CardContent className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-3">
          {rows.length > 0 && (
            <div className="flex flex-col gap-2">
              <DiffChipGroup rows={samplingRows} checked={checked} onToggle={toggle} profile={profile} />

              {perfRows.length > 0 && (
                <>
                  <p className="text-[11px] text-muted-foreground">{t("recommendPerfHint")}</p>
                  <DiffChipGroup rows={perfRows} checked={checked} onToggle={toggle} profile={profile} />
                </>
              )}
            </div>
          )}

          {profile.extras.length > 0 && (
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer select-none">
                {t("recommendExtras", { count: profile.extras.length })}
              </summary>
              <ul className="mt-1.5 flex flex-col gap-0.5 font-mono text-[11px]">
                {profile.extras.map((extra, index) => (
                  <li key={`${extra.flag}-${index}`}>
                    {extra.value === "" ? extra.flag : `${extra.flag} ${extra.value}`}
                  </li>
                ))}
              </ul>
            </details>
          )}

          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer select-none">{t("recommendExcerpt")}</summary>
            <pre className="mt-1.5 overflow-x-auto rounded-md bg-muted/50 p-2 font-mono text-[11px] whitespace-pre-wrap text-foreground">
              {profile.excerpt}
            </pre>
          </details>
        </div>
      </CardContent>

      {/* 按钮区固定在卡片底部、不随中间区域滚动；border-t 分隔线让「上面
          还能滚」这件事在视觉上可感知 */}
      <CardContent className="flex shrink-0 flex-wrap items-center gap-2 border-t pt-3">
        <Button size="sm" disabled={nothingSelected} onClick={() => onApply(currentSelection())}>
          {t("recommendApply")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={nothingSelected}
          onClick={() =>
            onSaveAsPreset(currentSelection(), suggestedPresetName(repoBaseName, profile.label))
          }
        >
          {t("recommendSavePreset")}
        </Button>
      </CardContent>
    </Card>
  );
}

function DiffChipGroup({
  rows,
  checked,
  onToggle,
  profile,
}: {
  rows: readonly DiffRow[];
  checked: ReadonlySet<ExtractableField>;
  onToggle: (field: ExtractableField, next: boolean) => void;
  profile: RecommendedProfile;
}) {
  const t = useTranslations("pages.repos");

  if (rows.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {rows.map((row) => {
        const isChecked = checked.has(row.field);
        return (
          <div key={row.field} className="flex flex-col gap-1">
            <label
              className={cn(
                "inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-xs",
                isChecked ? "border-primary/40 bg-primary/[0.06]" : "border-border",
              )}
            >
              <Checkbox checked={isChecked} onCheckedChange={(v) => onToggle(row.field, v === true)} />
              <span className="shrink-0">{row.field}</span>
              {/* 三列网格下卡宽只剩三分之一，值本身可能比整张卡还宽（长路径/
                  长枚举）——截断＋max-w 兜底，chip 撑破 min-w-0 的网格格子会
                  把整条 track 顶宽，参见 Card 上那条注释 */}
              <span className="max-w-24 truncate text-muted-foreground">{formatValue(row.current)}</span>
              <span className="shrink-0 text-muted-foreground">→</span>
              <span className="max-w-24 truncate font-semibold">{formatValue(row.next)}</span>
            </label>
            {profile.hits?.[row.field] !== undefined && (
              <details className="mt-1">
                <summary className="cursor-pointer text-[11px] text-muted-foreground">
                  {t("recommendHitSource")}
                </summary>
                <p className="mt-1 rounded bg-muted/50 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
                  {profile.hits[row.field]}
                </p>
              </details>
            )}
          </div>
        );
      })}
    </div>
  );
}
