"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";

import { SettingTip } from "@/components/setting-tip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatSize } from "@/lib/format";
import { NamespaceCreateNavButton } from "./namespace-create-nav-button";

interface NamespaceOption {
  value: string;
  label: string;
  count: number;
  sizeBytes: number;
  running: boolean;
}

export function NamespaceFilter({ value, options }: { value: string; options: NamespaceOption[] }) {
  const t = useTranslations("pages.models");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/50 px-7 py-3">
      <label htmlFor="namespace-filter" className="text-xs text-muted-foreground">{t("nsGroupLabel")}</label>
      <SettingTip text={t("nsFolderHint")} />
      <Select
        value={value}
        items={options.map((option) => ({ value: option.value, label: `${option.label} (${option.count})` }))}
        onValueChange={(next) => {
          if (next === null) return;
          const params = new URLSearchParams(searchParams.toString());
          params.set("ns", next);
          router.replace(`${pathname}?${params.toString()}`, { scroll: false });
        }}
      >
        <SelectTrigger id="namespace-filter" className="w-64 max-w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="start" alignItemWithTrigger={false} className="max-h-80 max-w-[calc(100vw-2rem)]">
          {options.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              label={`${option.label} (${option.count})`}
              className="[&>div]:min-w-0 [&>div]:shrink"
            >
              <span className="min-w-0 flex-1 truncate" title={option.label}>{option.label}</span>
              <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">{option.count} · {formatSize(option.sizeBytes)}</span>
              {option.running && (
                <span role="img" aria-label={t("nsRunningDot")} title={t("nsRunningDot")} className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
              )}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <NamespaceCreateNavButton />
    </div>
  );
}
