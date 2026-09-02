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

/** 来源 → 徽章文案键；`llm` 来源尚未有抽取器产出（预留给未来批次），
 *  未收录的来源不渲染徽章而不是抛错——卡片本身仍然可用 */
const SOURCE_BADGE_KEY: Partial<Record<RecommendedProfile["source"], string>> = {
  "cli-block": "recommendSourceCli",
  "kv-list": "recommendSourceKv",
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
  effective,
  repoBaseName,
  onApply,
  onSaveAsPreset,
}: {
  profile: RecommendedProfile;
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
    // flex h-full flex-col：三张卡内容多少不一，原先高度参差、按钮位置跟着
    // 错落（任务 3 真机反馈）；h-full 让卡片被网格行拉到等高（网格项默认
    // align-items: stretch），flex-col 配合下面「中间区域固定高度可滚动 +
    // 底部按钮区 shrink-0」，把「等高」落到「按钮固定在卡片底部」
    <Card className="min-w-0 flex h-full flex-col">
      {/* 卡头：label + 来源徽章，不参与滚动，一直钉在卡片顶部 */}
      <CardContent className="flex shrink-0 min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 break-words text-sm font-semibold">{profile.label || t("recommendUnnamed")}</span>
        {sourceBadgeKey !== undefined && (
          <Badge variant="outline" className="font-normal">
            {t(sourceBadgeKey)}
          </Badge>
        )}
      </CardContent>

      {/* 中间内容区固定高度（h-56，不是 max-height——内容少的卡也要撑到同样
          高度，三张卡才能等高）可滚动，参数 chip 区与「出处」折叠区都放在
          这里。用 min-h + flex-1 而不是死高度 h-56：三张卡的卡头行数可能不同
          （长 label 换行），网格把矮卡拉高时，死高度会让底部按钮区上方空出一条
          缝、按钮不再贴着卡片下沿；flex-1 让中间区吸收掉这段多余高度。原有的 chip
          换行、min-w-0、truncate 等窄卡适配全部保留 */}
      <CardContent className="min-h-56 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-3">
          {rows.length > 0 && (
            <div className="flex flex-col gap-2">
              <DiffChipGroup rows={samplingRows} checked={checked} onToggle={toggle} />

              {perfRows.length > 0 && (
                <>
                  <p className="text-[11px] text-muted-foreground">{t("recommendPerfHint")}</p>
                  <DiffChipGroup rows={perfRows} checked={checked} onToggle={toggle} />
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
}: {
  rows: readonly DiffRow[];
  checked: ReadonlySet<ExtractableField>;
  onToggle: (field: ExtractableField, next: boolean) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {rows.map((row) => {
        const isChecked = checked.has(row.field);
        return (
          <label
            key={row.field}
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
        );
      })}
    </div>
  );
}
