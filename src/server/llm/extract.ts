import type Database from "better-sqlite3";

import { extractJson } from "@/lib/llm-json";
import { buildLlmProfiles, type LlmExtractResult } from "@/lib/llm-profiles";
import { readmeCandidates } from "@/lib/readme-candidates";
import { splitFrontmatter } from "@/lib/readme-frontmatter";
import { readLlmCache, readReadmeCache, saveLlmCache } from "../hf/readme";
import { LlmError, type EngineDelta, type ExtractEngine } from "./engine";

/**
 * 一次 LLM 抽取的完整编排（批 3）
 *
 * 五步：切候选片段 → 引擎流式跑 → 抠 JSON → 逐字段回证 → 决定落不落库。
 *
 * **落库条件是「之前没有结果」**（D3）：首次直接存，重跑不存、把结果交给
 * 前端弹对比层，由用户决定覆盖还是保留旧的。花 API 额度换来的旧结果不该被
 * 一次未经确认的重跑冲掉。
 *
 * **「一套都没抠到」不是错误**：跑通了、原文里确实没写，这是正常结果，
 * 照样落库——否则用户每次进来都会重跑一次注定为空的解析。只有「模型吐不出
 * 合法 JSON」才是错误（badResponse），那说明这个模型干不了这活。
 */

export interface ExtractOutcome {
  result: LlmExtractResult;
  /** true = 之前已有 AI 结果，本次没落库，等用户在弹层里定夺 */
  hadPrevious: boolean;
  engine: "local" | "external";
  model: string;
  /** 候选片段是否因预算被截断，UI 要如实告知 */
  truncated: boolean;
  /** true = 模型输出本身被截断，抠取时丢弃了末尾不完整的一条才解出结果，UI 要如实告知 */
  repaired: boolean;
}

export async function runExtract(opts: {
  db: Database.Database;
  repo: string;
  engine: ExtractEngine;
  signal: AbortSignal;
  onDelta: (delta: EngineDelta) => void;
}): Promise<ExtractOutcome> {
  const cached = readReadmeCache(opts.db, opts.repo);
  if (cached === null || cached.content === null || cached.contentSha === null) {
    throw new LlmError("noReadme", "这个仓库还没有 README 可供解析");
  }

  const body = splitFrontmatter(cached.content).body;
  const candidates = readmeCandidates(body);

  const raw = await opts.engine.run({
    text: candidates.text,
    signal: opts.signal,
    onDelta: opts.onDelta,
  });

  const parsed = extractJson(raw);
  if (parsed === null) {
    throw new LlmError("badResponse", "模型没有返回可解析的 JSON");
  }

  // 回证用**整篇正文**而不是候选片段：片段是为了省 token 才裁的，
  // 用它回证会把"值确实在 README 里、只是不在这一段"的字段冤枉掉
  const result = buildLlmProfiles(parsed.value, body);

  const previous = readLlmCache(opts.db, opts.repo);
  const hadPrevious = previous !== null && previous.profiles !== null;

  if (!hadPrevious) {
    saveLlmCache(opts.db, opts.repo, {
      profiles: JSON.stringify(result.profiles),
      engine: opts.engine.id,
      model: opts.engine.model,
      contentSha: cached.contentSha,
    });
  }

  return {
    result,
    hadPrevious,
    engine: opts.engine.id,
    model: opts.engine.model,
    truncated: candidates.truncated,
    repaired: parsed.repaired,
  };
}
