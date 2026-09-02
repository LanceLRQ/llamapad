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
    <Card>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">{profile.label || t("recommendUnnamed")}</span>
          {sourceBadgeKey !== undefined && (
            <Badge variant="outline" className="font-normal">
              {t(sourceBadgeKey)}
            </Badge>
          )}
        </div>

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

        <div className="flex items-center gap-2 pt-1">
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
        </div>
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
            <span>{row.field}</span>
            <span className="text-muted-foreground">{formatValue(row.current)}</span>
            <span className="text-muted-foreground">→</span>
            <span className="font-semibold">{formatValue(row.next)}</span>
          </label>
        );
      })}
    </div>
  );
}
