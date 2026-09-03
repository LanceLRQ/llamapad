/**
 * 从模型输出的一坨文本里抠出 JSON（README 推荐参数的 LLM 解析，批 3）
 *
 * 即使请求里带了 `response_format: json_object`，也不能假定拿到的就是纯 JSON：
 * 实测某些 provider 对 `json_schema` **静默失效**——HTTP 200、不报错，返回的却是
 * 散文。约束是尽力而为，这一层才是真正的防线。
 *
 * **抠不出就返回 null，绝不补全**。给一个被 max_tokens 截断的 JSON 补上收尾括号，
 * 等于替模型编造它没说完的话，而下游的回证根本挡不住这种编造——那些值确实
 * 在原文里出现过，只是模型还没说完它要把它们放在哪。
 */

/** 顶层必须是对象：数组无法承载 profiles 之外的元信息，也不是 prompt 约定的形状 */
export function extractJson(raw: string): Record<string, unknown> | null {
  const text = stripFence(raw).trim();
  if (text === "") return null;

  const start = text.indexOf("{");
  if (start === -1) return null;

  const end = matchingBrace(text, start);
  if (end === -1) return null;

  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function stripFence(raw: string): string {
  const fence = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/.exec(raw);
  return fence === null ? raw : fence[1]!;
}

/** 从 start 处的 `{` 找配对的 `}`；字符串字面量内的括号不计数。找不到返回 -1 */
function matchingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
