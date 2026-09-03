import { serverConfigSchema, type ServerConfig } from "@/core/schemas";
import {
  fieldAliases,
  profileId,
  signatureHash,
  toServerField,
  type ExtractableField,
  type RecommendedProfile,
} from "./readme-params";
import { verifyValue } from "./readme-verify";

/**
 * 模型输出的 JSON → 经回证的推荐卡数据（README 推荐参数的 LLM 解析，批 3）
 *
 * 每个字段要连过三道：
 * 1. **字段名认得出**（`toServerField`，与规则抽取器共用同一张同义词表）——认不出
 *    进 extras 如实展示，不算丢弃
 * 2. **值过得了该字段自己的 schema**——越界一律丢弃不钳，`temp: 5` 是模型错了，
 *    夹到 2 是替它圆谎
 * 3. **值能在 README 原文里字面命中**（`verifyValue`）——这一道挡的是幻觉
 *
 * `offered` / `dropped` 必须如实回给 UI。用户看到“给了 4 个、丢了 2 个”才知道
 * 这份结果经过了筛选，而不是模型只说了两句话。**这个计数不是调试信息。**
 */

export interface LlmExtractResult {
  profiles: RecommendedProfile[];
  /** 模型给出的字段总数（不含认不出的 extras） */
  offered: number;
  /** 因值域或回证不通过而丢弃的字段数 */
  dropped: number;
}

interface RawProfile {
  label?: unknown;
  params?: unknown;
}

const EMPTY: LlmExtractResult = { profiles: [], offered: 0, dropped: 0 };

export function buildLlmProfiles(raw: unknown, body: string): LlmExtractResult {
  if (raw === null || typeof raw !== "object") return EMPTY;
  const list = (raw as { profiles?: unknown }).profiles;
  if (!Array.isArray(list)) return EMPTY;

  const bySignature = new Map<string, RecommendedProfile>();
  let offered = 0;
  let dropped = 0;

  for (const item of list) {
    if (item === null || typeof item !== "object") continue;
    const { label, params } = item as RawProfile;
    if (params === null || typeof params !== "object" || Array.isArray(params)) continue;

    const server: Record<string, unknown> = {};
    const extras: { flag: string; value: string }[] = [];
    const hits: Record<string, string> = {};
    const weak: ExtractableField[] = [];

    for (const [rawKey, rawValue] of Object.entries(params as Record<string, unknown>)) {
      const field = toServerField(rawKey);
      if (field === null) {
        extras.push({ flag: rawKey, value: String(rawValue) });
        continue;
      }

      offered++;
      const parsed = serverConfigSchema.shape[field].safeParse(rawValue);
      if (!parsed.success) {
        dropped++;
        continue;
      }
      const hit = verifyValue(parsed.data, body, fieldAliases(field));
      if (hit === null) {
        dropped++;
        continue;
      }
      server[field] = parsed.data;
      hits[field] = hit.sentence;
      // 弱命中仍然算命中、不计入 dropped——它只是可信度低一档，由卡片标注给用户
      if (hit.strength === "weak") weak.push(field);
    }

    if (Object.keys(server).length === 0) continue;

    const typed = server as Partial<ServerConfig>;
    const key = signatureHash(typed);
    if (bySignature.has(key)) continue; // 同一套值重复给出，留先到的

    bySignature.set(key, {
      id: profileId("llm", typed),
      label: typeof label === "string" ? label : "",
      source: "llm",
      server: typed,
      extras,
      // AI 结果的出处是逐字段的 hits，不需要整段 excerpt
      excerpt: "",
      // 恒为 medium：过了回证只说明“原文里有这个数”，不说明“作者是把它当这个参数推荐的”
      confidence: "medium",
      hits,
      // 空数组不写这个键：规则卡与库里旧的 AI 结果都没有它，凭空加一个空字段
      // 只会让「有没有弱命中」这件事多一种表示形式
      ...(weak.length > 0 ? { weakFields: weak } : {}),
    });
  }

  return { profiles: [...bySignature.values()], offered, dropped };
}
