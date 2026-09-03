/**
 * 抽取提示词（批 3）
 *
 * 用英文写：目标 README 绝大多数是英文，同语言的指令让模型更少走神。
 *
 * 措辞的每一条都对应回证闸门的一种失败模式——**提示词是第一道防线，回证是最后一道**。
 * 只有一道时，模型会很乐意把 "0.5-0.7" 折中成 0.6 再告诉你那是作者说的。
 */
export function buildExtractPrompt(candidateText: string): string {
  return `You extract llama.cpp sampling parameters that a model author explicitly wrote in a README.

Rules:
- Only output values that literally appear in the text below. Never infer, never average a range, never convert units (do not turn "32k" into 32768), never fill in defaults.
- If the text gives a range and also a recommended value, output only the recommended value.
- If the text mentions several distinct setups (for example thinking vs non-thinking), output one entry per setup and give each a short label taken from the text.
- If the text contains no explicit parameter values, output {"profiles": []}.
- Output JSON only, no explanation, no code fence.

Output shape:
{"profiles":[{"label":"...","params":{"temp":0.6,"top_p":0.95}}]}

Text:
${candidateText}`;
}
