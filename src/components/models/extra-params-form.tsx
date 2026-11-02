"use client";

import { useId, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Search } from "lucide-react";
import {
  EXTRA_GROUPS, EXTRA_PARAMS, LLAMA_OPTIONS_SOURCE, draftToExtra, extraParamsSchema,
  rawExtraConflicts, searchExtraParams, type ExtraDraft, type ExtraParams,
} from "@/core/extra-params";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export function ExtraParamsForm({ draft, defaults = {}, onChange, extraArgs = [], argsOverride, ctxSize }: {
  draft: ExtraDraft;
  defaults?: ExtraParams;
  onChange: (draft: ExtraDraft) => void;
  extraArgs?: string[];
  argsOverride?: string[];
  ctxSize: number;
}) {
  const t = useTranslations("extraParams");
  const lang = useLocale().startsWith("zh") ? "zh" : "en";
  const id = useId();
  const [query, setQuery] = useState("");
  const [configuredOnly, setConfiguredOnly] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const values = draftToExtra(draft);
  const effective = { ...defaults, ...values };
  const checked = extraParamsSchema.safeParse(values);
  const errors = new Map(checked.success ? [] : checked.error.issues.map((issue) => [String(issue.path[0]), issue.message]));
  const matches = searchExtraParams(query, configuredOnly, draft, defaults);
  const conflicts = rawExtraConflicts(effective, extraArgs);
  const count = Object.keys(values).length;
  const set = (key: string, value: string) => onChange({ ...draft, [key]: value });

  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h2 className="text-sm font-semibold">{t("title")}</h2>
            <p className="max-w-3xl text-xs text-muted-foreground">{t("intro", { count: EXTRA_PARAMS.length })}</p>
          </div>
          <span className="text-xs text-muted-foreground">{t("count", { count })}</span>
        </div>
        <p className="text-xs text-muted-foreground">
          {t("baseline", { commit: LLAMA_OPTIONS_SOURCE.commit.slice(0, 8) })}{" "}
          <a href={LLAMA_OPTIONS_SOURCE.url} target="_blank" rel="noreferrer" className="underline underline-offset-4">{t("docs")}</a>
        </p>
        {argsOverride !== undefined && <p role="status" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">{t("argsOverride")}</p>}
        {conflicts.length > 0 && <p role="status" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">{t("conflicts", { flags: conflicts.join(", ") })}</p>}
        {extraArgs.length > 0 && <p className="text-xs text-muted-foreground">{t("rawArgs")}</p>}
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-0 flex-1 basis-64">
            <Search aria-hidden className="absolute top-2.5 left-3 size-4 text-muted-foreground" />
            <Input aria-label={t("search")} placeholder={t("search")} value={query} onChange={(e) => setQuery(e.target.value)} className="pl-9" type="search" />
          </div>
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={configuredOnly} onChange={(e) => setConfiguredOnly(e.target.checked)} />
            {t("configuredOnly")}
          </label>
        </div>
        <p className="text-xs text-muted-foreground" aria-live="polite">{t("matches", { count: matches.length })}</p>
        {matches.length === 0 && <p className="py-4 text-sm text-muted-foreground">{t("empty")}</p>}
        {EXTRA_GROUPS.map((group) => {
          const entries = matches.filter((p) => p.group === group);
          if (entries.length === 0) return null;
          const configured = entries.some((p) => values[p.key] !== undefined || defaults[p.key] !== undefined);
          const open = query.trim() !== "" || (expanded[group] ?? (group === "common" || configured));
          return (
            <details key={group} open={open} className="rounded-lg border">
              <summary className="cursor-pointer px-4 py-3 text-sm font-medium" onClick={(e) => {
                e.preventDefault(); setExpanded({ ...expanded, [group]: !open });
              }}>{t(`groups.${group}`)} <span className="ml-2 text-xs text-muted-foreground">{entries.length}</span></summary>
              <div className="grid grid-cols-1 gap-x-6 gap-y-5 border-t p-4 xl:grid-cols-2">
                {entries.map((p) => {
                  const raw = draft[p.key] ?? "";
                  const inherited = raw === "" && defaults[p.key] !== undefined;
                  const fieldId = `${id}-${p.key}`;
                  const select = p.kind === "boolean" || p.kind === "enum";
                  const multiline = ["repeat", "json"].includes(p.kind) || ["grammar", "chat_template"].includes(p.key);
                  const upstreamDefault = p.description.en.match(/default:\s*([^\n)]+)/i)?.[1];
                  const bounds = [p.min !== undefined ? `≥ ${p.min}` : "", p.exclusiveMin !== undefined ? `> ${p.exclusiveMin}` : "", p.max !== undefined ? `≤ ${p.max}` : "", p.nonzero ? "≠ 0" : ""].filter(Boolean).join(", ");
                  return (
                    <div key={p.key} className="flex min-w-0 flex-col gap-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <label htmlFor={fieldId} className="text-xs font-medium">{p.label[lang]}</label>
                        {raw !== "" && <Button type="button" variant="ghost" size="sm" onClick={() => set(p.key, "")} className="h-6 px-2 text-xs">{t("clear")}</Button>}
                      </div>
                      <code className="break-all text-[11px] text-muted-foreground">{p.signature}</code>
                      {p.experimental && <span className="text-xs text-amber-700 dark:text-amber-400">{t("experimental")}</span>}
                      <p id={`${fieldId}-help`} className="whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">{p.description[lang]}</p>
                      {p.kind === "number" && <p className="text-[11px] text-muted-foreground">{t("numberType", { type: p.integer ? t("integer") : t("decimal"), range: bounds || t("unbounded") })}</p>}
                      <p className="text-[11px] text-muted-foreground">{upstreamDefault ? t("upstreamDefault", { value: upstreamDefault }) : t("unknownDefault")}</p>
                      {select ? (
                        <select id={fieldId} value={raw} onChange={(e) => set(p.key, e.target.value)} aria-describedby={`${fieldId}-help ${fieldId}-state`} aria-invalid={errors.has(p.key) || undefined} className="h-9 w-full min-w-0 rounded-md border bg-background px-3 text-sm">
                          <option value="">{t("unset")}</option>
                          {p.kind === "boolean" ? <><option value="true">{t("enabled")}</option><option value="false">{t("disabled")}</option></> : p.choices?.map((choice) => <option key={choice} value={choice}>{choice}</option>)}
                        </select>
                      ) : multiline ? (
                        <Textarea id={fieldId} rows={3} value={raw} onChange={(e) => set(p.key, e.target.value)} placeholder={p.valueHint} aria-describedby={`${fieldId}-help ${fieldId}-state`} aria-invalid={errors.has(p.key) || undefined} className="font-mono text-xs" />
                      ) : (
                        <Input id={fieldId} type={p.sensitive ? "password" : "text"} inputMode={p.kind === "number" ? "decimal" : undefined} autoComplete="off" spellCheck={false} value={raw} onChange={(e) => set(p.key, e.target.value)} placeholder={p.valueHint} aria-describedby={`${fieldId}-help ${fieldId}-state`} aria-invalid={errors.has(p.key) || undefined} className="font-mono text-xs" />
                      )}
                      <p id={`${fieldId}-state`} className="text-[11px] text-muted-foreground">{inherited ? t("inherited", { value: p.sensitive ? "••••••" : Array.isArray(defaults[p.key]) ? JSON.stringify(defaults[p.key]) : String(defaults[p.key]) }) : raw === "" ? t("notPassed") : t("modelValue")}</p>
                      {p.kind === "boolean" && !p.negativeFlag && <p className="text-[11px] text-muted-foreground">{t("flagOnly")}</p>}
                      {errors.has(p.key) && <p role="alert" className="text-xs text-destructive">{errors.get(p.key)}</p>}
                      {lang === "zh" && <details className="text-[11px] text-muted-foreground"><summary className="cursor-pointer">{t("upstreamDetails")}</summary><p className="mt-1 whitespace-pre-wrap break-words">{p.description.en}</p></details>}
                    </div>
                  );
                })}
              </div>
            </details>
          );
        })}
        <p className="rounded-lg bg-muted/50 p-3 text-xs leading-relaxed text-muted-foreground">{t("capacity", { ctx: ctxSize, parallel: effective.parallel === undefined || effective.parallel === -1 ? t("auto") : String(effective.parallel), mode: effective.kv_unified === undefined ? t("auto") : effective.kv_unified ? t("shared") : t("divided") })}</p>
        <p className="text-xs text-muted-foreground">{t("paths")}</p>
        <p className="text-xs text-muted-foreground">{t("restart")}</p>
      </CardContent>
    </Card>
  );
}

export function ExtraParamsPreview({ values = {}, overrides = {}, extraArgs = [], argsOverride }: {
  values?: ExtraParams; overrides?: ExtraParams; extraArgs?: string[]; argsOverride?: string[];
}) {
  const t = useTranslations("extraParams");
  const lang = useLocale().startsWith("zh") ? "zh" : "en";
  const entries = EXTRA_PARAMS.filter((p) => values[p.key] !== undefined);
  const conflicts = rawExtraConflicts(values, extraArgs);
  return <div className="flex flex-col gap-2">
    <h3 className="text-xs font-medium">{t("title")}</h3>
    {argsOverride !== undefined && <p role="status" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">{t("argsOverride")}</p>}
    {conflicts.length > 0 && <p role="status" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">{t("conflicts", { flags: conflicts.join(", ") })}</p>}
    {(argsOverride !== undefined || extraArgs.length > 0) && <p className="text-xs text-muted-foreground">{t("previewConfigValues")}</p>}
    {entries.length === 0 && <p className="text-xs text-muted-foreground">{t("notPassed")}</p>}
    <dl className="flex flex-col gap-2 text-xs">{entries.map((p) => <div key={p.key} className="flex flex-wrap items-baseline justify-between gap-2">
      <dt className="font-mono">{p.flag}</dt>
      <dd className="min-w-0 break-all text-right"><span>{p.sensitive ? "••••••" : Array.isArray(values[p.key]) ? JSON.stringify(values[p.key]) : String(values[p.key])}</span><span className="ml-2 text-muted-foreground">{overrides[p.key] === undefined ? t("globalSource") : t("modelSource")}</span><span className="sr-only">{p.label[lang]}</span></dd>
    </div>)}</dl>
  </div>;
}
