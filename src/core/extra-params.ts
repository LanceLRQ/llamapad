import { z } from "zod";
import source from "./llama-options.json";

export type ExtraValue = string | number | boolean | string[];
export type ExtraParams = Record<string, ExtraValue>;
export type ExtraDraft = Record<string, string>;
export interface ExtraParam {
  key: string;
  flag: string;
  aliases: string[];
  signature: string;
  group: string;
  kind: "boolean" | "number" | "string" | "enum" | "json" | "repeat" | "range" | "layers";
  label: { zh: string; en: string };
  description: { zh: string; en: string };
  valueHint: string;
  experimental: boolean;
  sensitive: boolean;
  negativeFlag?: string;
  choices?: string[];
  integer?: boolean;
  min?: number;
  max?: number;
  exclusiveMin?: number;
  nonzero?: boolean;
}

export const LLAMA_OPTIONS_SOURCE = source;
export const EXTRA_PARAMS = source.options as ExtraParam[];
export const EXTRA_GROUPS = ["common", "context", "cpu", "hardware", "sampling", "chat", "multimodal", "speculative", "loading", "server", "logging"] as const;
const byKey = new Map(EXTRA_PARAMS.map((p) => [p.key, p]));

export const extraParamsSchema = z.record(
  z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
).superRefine((values, ctx) => {
  for (const [key, value] of Object.entries(values)) {
    const p = byKey.get(key);
    let error: string | undefined;
    if (!p) error = "Unknown llama-server parameter";
    else if (p.kind === "boolean") {
      if (typeof value !== "boolean") error = "Expected boolean";
    } else if (p.kind === "number") {
      if (typeof value !== "number" || !Number.isFinite(value)) error = "Expected finite number";
      else if (p.integer && !Number.isSafeInteger(value)) error = "Expected integer";
      else if (p.min !== undefined && value < p.min) error = `Minimum: ${p.min}`;
      else if (p.max !== undefined && value > p.max) error = `Maximum: ${p.max}`;
      else if (p.exclusiveMin !== undefined && value <= p.exclusiveMin) error = `Must exceed ${p.exclusiveMin}`;
      else if (p.nonzero && value === 0) error = "Zero is not supported";
    } else if (p.kind === "layers") {
      if (value !== "auto" && value !== "all" && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)) error = "Expected non-negative integer, auto or all";
    } else if (p.kind === "repeat" || p.kind === "range") {
      if (!Array.isArray(value) || value.length === 0 || value.some((v) => v.length === 0)) error = "Expected non-empty list";
      else if (p.kind === "range" && (value.length !== 2 || value.some((v) => !/^\d+$/.test(v)) || Number(value[0]) > Number(value[1]))) {
        error = "Expected START END integers with START <= END";
      }
    } else if (typeof value !== "string" || value.trim() === "") error = "Expected non-empty text";
    else if (p.kind === "enum" && !p.choices?.includes(value)) error = `Allowed: ${p.choices?.join(", ")}`;
    else if (p.kind === "json") {
      try {
        const parsed: unknown = JSON.parse(value);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) error = "Expected JSON object";
        else if (key === "chat_template_kwargs" && ("enable_thinking" in parsed || "reasoning_effort" in parsed)) {
          error = "Use the dedicated thinking / reasoning effort fields";
        }
      } catch { error = "Invalid JSON object"; }
    }
    if (error) ctx.addIssue({ code: "custom", path: [key], message: `${p?.flag ?? key}: ${error}` });
  }
});

/** One argv element per value; never split values using shell syntax. */
export function buildExtraArgs(values: ExtraParams): string[] {
  const checked = extraParamsSchema.parse(values);
  const args: string[] = [];
  for (const p of EXTRA_PARAMS) {
    const value = checked[p.key];
    if (value === undefined || p.key === "chat_template_kwargs") continue;
    if (p.kind === "boolean") {
      if (value === true) args.push(p.flag);
      else if (p.negativeFlag) args.push(p.negativeFlag);
    } else if (Array.isArray(value)) {
      if (p.kind === "range") args.push(p.flag, ...value);
      else for (const entry of value) args.push(p.flag, entry);
    } else args.push(p.flag, String(value));
  }
  return args;
}

export function extraToDraft(values: ExtraParams | undefined): ExtraDraft {
  return Object.fromEntries(Object.entries(values ?? {}).map(([key, value]) => {
    const p = byKey.get(key);
    return [key, Array.isArray(value) ? value.join(p?.kind === "range" ? " " : "\n") : String(value)];
  }));
}

/** Invalid in-progress values remain visible to schema validation instead of disappearing. */
export function draftToExtra(draft: ExtraDraft): ExtraParams {
  return Object.fromEntries(Object.entries(draft).filter(([, raw]) => raw !== "").map(([key, raw]) => {
    const p = byKey.get(key);
    let value: ExtraValue = raw;
    if (p?.kind === "number" || p?.kind === "layers") value = raw.trim() === "" ? raw : Number.isFinite(Number(raw)) ? Number(raw) : raw;
    else if (p?.kind === "boolean" && (raw === "true" || raw === "false")) value = raw === "true";
    else if (p?.kind === "repeat") value = raw.split("\n");
    else if (p?.kind === "range") value = raw.trim().split(/\s+/);
    return [key, value];
  }));
}

export function searchExtraParams(query: string, configuredOnly = false, draft: ExtraDraft = {}, defaults: ExtraParams = {}): ExtraParam[] {
  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return EXTRA_PARAMS.filter((p) => {
    if (configuredOnly && !draft[p.key] && defaults[p.key] === undefined) return false;
    const haystack = [p.key, ...p.aliases, p.label.zh, p.label.en, p.description.zh, p.description.en].join(" ").toLocaleLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

/** Parse argv boundaries so a stop-text value that resembles a flag is not mistaken for an override. */
export function rawExtraConflicts(values: ExtraParams, argv: string[]): string[] {
  const hits = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const flag = token.split("=", 1)[0];
    const p = EXTRA_PARAMS.find((entry) => entry.aliases.includes(flag));
    if (p) {
      if (values[p.key] !== undefined) hits.add(p.flag);
      if (!token.includes("=")) i += p.kind === "boolean" ? 0 : p.kind === "range" ? 2 : 1;
    } else {
      const owned = source.excluded.find((entry) => entry.signature.split(/[,\s]+/).includes(flag));
      if (owned && !token.includes("=") && /\s[A-Z][A-Z_]*(?:$|\s)/.test(owned.signature)) i += 1;
    }
  }
  return [...hits];
}
