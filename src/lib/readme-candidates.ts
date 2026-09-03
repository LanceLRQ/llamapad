/**
 * README → 喂给 LLM 的候选片段（README 推荐参数的 LLM 解析，批 3）
 *
 * 不喂整篇有两个硬理由：本地引擎跑在用户自己配的 `ctx_size` 上，配小了必然
 * 静默截断；而长上下文里的无关内容会让模型去"推断"参数，那正是回证要挡的东西。
 *
 * 打分只看关键词密度，不做语义判断——判断留给模型，面板只负责别把明显无关的
 * 段落塞进去。全篇都无关时仍然回一段：让模型自己说"没有"，比面板替它判断更诚实。
 */

/** 默认预算，约 1.5k token（中文更省，英文约 1.5 字符/token 的保守估计） */
export const DEFAULT_CANDIDATE_BUDGET = 6000;

const KEYWORDS = [
  "temperature", "temp", "top_p", "top-p", "top_k", "top-k", "min_p", "min-p",
  "penalty", "ctx", "context", "n_gpu_layers", "ngl", "flash", "cache-type",
  "recommend", "setting", "parameter", "sampling", "llama-server", "llama-cli",
  "推荐", "参数", "温度", "采样", "配置",
];

interface Block {
  /** 在原文中的序号，用于最后按原文序拼回 */
  order: number;
  text: string;
  score: number;
}

/** 先按 fenced code block 切开，块内不再按空行拆——一条多行命令必须整块保留 */
function splitBlocks(body: string): string[] {
  const out: string[] = [];
  const fence = /```[\s\S]*?```/g;
  let last = 0;
  for (let m = fence.exec(body); m !== null; m = fence.exec(body)) {
    out.push(...body.slice(last, m.index).split(/\n{2,}/));
    out.push(m[0]);
    last = m.index + m[0].length;
  }
  out.push(...body.slice(last).split(/\n{2,}/));
  return out.map((s) => s.trim()).filter((s) => s !== "");
}

function scoreOf(text: string): number {
  const lower = text.toLowerCase();
  return KEYWORDS.reduce((sum, kw) => (lower.includes(kw) ? sum + 1 : sum), 0);
}

export interface CandidateText {
  text: string;
  /** true = 有段落因预算被丢掉，UI 需要如实告知 */
  truncated: boolean;
}

export function readmeCandidates(
  body: string,
  budget: number = DEFAULT_CANDIDATE_BUDGET,
): CandidateText {
  const blocks: Block[] = splitBlocks(body).map((text, order) => ({
    order,
    text,
    score: scoreOf(text),
  }));
  if (blocks.length === 0) return { text: "", truncated: false };

  // 高分在前；同分保持原文序，让拼回的结果尽量贴近原文结构
  const ranked = [...blocks].sort((a, b) => (b.score - a.score) || (a.order - b.order));

  const picked: Block[] = [];
  let used = 0;
  let truncated = false;
  for (const block of ranked) {
    const cost = block.text.length + 2; // 段落间的空行
    if (used + cost > budget) {
      truncated = true;
      continue; // 继续试后面更短的段落，而不是直接停——短段落也可能含关键信息
    }
    picked.push(block);
    used += cost;
  }

  // 一段都放不下时，截取分最高的那段的前 budget 个字符：空片段等于放弃整个功能
  if (picked.length === 0) {
    return { text: ranked[0]!.text.slice(0, budget), truncated: true };
  }

  picked.sort((a, b) => a.order - b.order);
  return { text: picked.map((b) => b.text).join("\n\n"), truncated };
}
