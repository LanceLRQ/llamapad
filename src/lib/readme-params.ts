import { serverConfigSchema, type ServerConfig } from "@/core/schemas";
import { cliFlagGroups } from "./readme-cli-block";
import { kvGroups } from "./readme-kv";

/**
 * README 键值对 → 推荐参数（README 推荐参数抽取）
 *
 * T13/T14 只负责「从文本里切出原样的键值对」，语义全在这里：归一化键名、
 * 按 schema 裁决值、分流 extras、去重、装配。
 *
 * **值域一律复用 `serverConfigSchema` 的字段 schema**，不在这里重抄一份数字范围——
 * 抄一份就意味着将来改值域要改两处，必漏。越界值**直接丢弃不钳**：
 * README 写 `temp=5` 就是 README 错了，夹到 2 是替作者圆谎。
 */

/** 可抽取的字段。刻意不等于 `serverConfigSchema` 全集——`host` 在 README 里是
 *  作者本机的绑定地址（`--host 127.0.0.1`），不是给别人的推荐。
 *  （字段清单只有这一处：简报原稿的 `EXTRACTABLE` 数组只被 `typeof` 消费、
 *  没有运行时用途，被 eslint 判 unused，改成纯类型联合语义不变） */
export type ExtractableField =
  | "temp"
  | "top_p"
  | "top_k"
  | "min_p"
  | "repeat_penalty"
  | "presence_penalty"
  | "enable_thinking"
  | "reasoning_effort"
  | "ctx_size"
  | "gpu_layers"
  | "batch_size"
  | "ubatch_size"
  | "cache_type_k"
  | "cache_type_v"
  | "flash_attention";

/** 采样类：模型作者真正懂、且与用户硬件无关，UI 默认勾选 */
export const SAMPLING_FIELDS: ReadonlySet<ExtractableField> = new Set([
  "temp", "top_p", "top_k", "min_p", "repeat_penalty", "presence_penalty",
  "enable_thinking", "reasoning_effort",
]);

/** 性能类：与显存强相关，UI 默认不勾（HauhauCS 的 ctx 204800 是在 96GB 卡上测的） */
export const PERF_FIELDS: ReadonlySet<ExtractableField> = new Set([
  "ctx_size", "gpu_layers", "batch_size", "ubatch_size",
  "cache_type_k", "cache_type_v", "flash_attention",
]);

/**
 * 归一化后的键 → 字段。**短参数只认这张表里的**：`-t` 是 threads 不是
 * temperature，`-n` 是 n_predict，`-p` 是提示词——把它们当采样参数会产出
 * 灾难性的坏配置（实测 unsloth 与 TheBloke 的命令里都有 `--threads`）。
 */
const SYNONYMS: Record<string, ExtractableField> = {
  temperature: "temp", temp: "temp",
  top_p: "top_p", top_k: "top_k", min_p: "min_p",
  presence_penalty: "presence_penalty",
  repetition_penalty: "repeat_penalty", repeat_penalty: "repeat_penalty",
  ctx_size: "ctx_size", c: "ctx_size",
  n_gpu_layers: "gpu_layers", gpu_layers: "gpu_layers", ngl: "gpu_layers",
  batch_size: "batch_size", b: "batch_size",
  ubatch_size: "ubatch_size", ub: "ubatch_size",
  cache_type_k: "cache_type_k", ctk: "cache_type_k",
  cache_type_v: "cache_type_v", ctv: "cache_type_v",
  flash_attn: "flash_attention", flash_attention: "flash_attention", fa: "flash_attention",
  enable_thinking: "enable_thinking",
  reasoning_effort: "reasoning_effort",
};

const NUMERIC: ReadonlySet<ExtractableField> = new Set([
  "temp", "top_p", "top_k", "min_p", "repeat_penalty", "presence_penalty",
  "ctx_size", "gpu_layers", "batch_size", "ubatch_size",
]);

export interface RecommendedProfile {
  /** 稳定 key：来源 + 字段签名的短 hash，同样输入必得同样 id */
  id: string;
  label: string;
  source: "cli-block" | "kv-list" | "llm";
  server: Partial<ServerConfig>;
  /** 映射不到面板 schema 的参数：展示但不应用（如 --spec-type / --jinja） */
  extras: { flag: string; value: string }[];
  /** README 原文片段，供用户核对 */
  excerpt: string;
  confidence: "high" | "medium";
}

/** 去前导横线 → `-` 换 `_` → 驼峰拆下划线 → 全小写。实测四种拼法一次吃掉 */
export function normalizeParamKey(key: string): string {
  return key
    .replace(/^-+/, "")
    .replace(/-/g, "_")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

/** 未命中同义词表一律返回 null（调用方据此丢进 extras） */
export function toServerField(key: string): ExtractableField | null {
  return SYNONYMS[normalizeParamKey(key)] ?? null;
}

/** 用字段自己的 schema 裁决；不合法返回 null（丢弃，不钳） */
function acceptValue(field: ExtractableField, raw: string): unknown | null {
  const cleaned = raw.replace(/[,;]+$/, "").replace(/^["'`]|["'`]$/g, "").trim();

  let candidate: unknown;
  if (field === "enable_thinking") {
    const lower = cleaned.toLowerCase();
    if (lower !== "true" && lower !== "false") return null; // Python 的 True/False 在此归一化
    candidate = lower === "true";
  } else if (NUMERIC.has(field)) {
    // `--n-gpu-layers all` 这类非数值写法一律不收：把 "all" 猜成 999 是解释而不是
    // 抽取，越出「只抠 README 里写了的东西」这条线
    const n = Number(cleaned);
    if (cleaned === "" || !Number.isFinite(n)) return null;
    candidate = n;
  } else {
    candidate = cleaned.toLowerCase();
  }

  const parsed = serverConfigSchema.shape[field].safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/** FNV-1a：只用来做稳定 key，不要求密码学强度（也不能用 node:crypto——这文件跑在浏览器里） */
function shortHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** 至少一个采样类字段，或字段数 >=3。挡掉「把 -c 调大跑长文本」这类片段示例 */
function worthKeeping(server: Partial<ServerConfig>): boolean {
  const keys = Object.keys(server) as ExtractableField[];
  if (keys.length === 0) return false;
  return keys.some((k) => SAMPLING_FIELDS.has(k)) || keys.length >= 3;
}

function buildProfile(
  source: RecommendedProfile["source"],
  label: string,
  pairs: { key: string; value: string }[],
  excerpt: string,
): RecommendedProfile | null {
  const server: Record<string, unknown> = {};
  const extras: { flag: string; value: string }[] = [];

  for (const { key, value } of pairs) {
    const field = toServerField(key);
    if (field === null) {
      extras.push({ flag: key, value });
      continue;
    }
    // 无值开关：老版本 llama.cpp 的 -fa 就是纯开关，等价于 on
    const raw = value === "" && field === "flash_attention" ? "on" : value;
    const accepted = acceptValue(field, raw);
    if (accepted === null) extras.push({ flag: key, value });
    else server[field] = accepted;
  }

  const typed = server as Partial<ServerConfig>;
  if (!worthKeeping(typed)) return null;

  return {
    id: `${source}-${shortHash(signatureOf(typed))}`,
    label,
    source,
    server: typed,
    extras,
    excerpt,
    confidence: "high",
  };
}

/** 字段签名：排序后的 k=v 串。同一套推荐无论来自哪条来源，签名必然一致 */
function signatureOf(server: Partial<ServerConfig>): string {
  return Object.entries(server)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(",");
}

/**
 * 从 README 正文抽出全部推荐。跨来源合并：字段签名完全相同的只留一条，
 * 优先保留 label 非空的那条（kv-list 自带 Thinking Mode 这类语义标签，
 * cli-block 的 label 恒为空串），都有或都没有时保留先到的——同一篇里
 * 命令块与「Recommended settings」列表常给出同一组值，HauhauCS 就是。
 *
 * **子集折叠是刻意不做的**：字段少的推荐恰为字段多的子集时，既可能是同一套
 * 推荐的详略两种写法，也可能是作者另给的精简配置，从文本本身分不出来；
 * 折叠会把独立推荐连同它的语义标签一起吃掉，宁多留一条也不误删。
 */
export function extractRecommendations(markdown: string): RecommendedProfile[] {
  const profiles: RecommendedProfile[] = [];

  for (const group of cliFlagGroups(markdown)) {
    const profile = buildProfile(
      "cli-block",
      "",
      group.flags.map((f) => ({ key: f.flag, value: f.value })),
      group.excerpt,
    );
    if (profile !== null) profiles.push(profile);
  }

  for (const group of kvGroups(markdown)) {
    const profile = buildProfile("kv-list", group.label, group.pairs, group.excerpt);
    if (profile !== null) profiles.push(profile);
  }

  // key 用签名 hash 本身，不从 id 切片——id 前缀（cli-block / kv-list）自身
  // 含连字符，切出来的 key 会带着来源痕迹，跨来源同签名就进不了同一个桶
  const bySignature = new Map<string, RecommendedProfile>();
  for (const profile of profiles) {
    const key = shortHash(signatureOf(profile.server));
    const existing = bySignature.get(key);
    if (existing === undefined || (profile.label !== "" && existing.label === "")) {
      bySignature.set(key, profile);
    }
  }
  return [...bySignature.values()];
}
