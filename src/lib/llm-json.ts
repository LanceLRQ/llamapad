/**
 * 从模型输出的一坨文本里抠出 JSON（README 推荐参数的 LLM 解析，批 3）
 *
 * 即使请求里带了 `response_format: json_object`，也不能假定拿到的就是纯 JSON：
 * 实测某些 provider 对 `json_schema` **静默失效**——HTTP 200、不报错，返回的却是
 * 散文；本地小模型还有另一种失效模式——**输出被 max_tokens 截断**，最外层的
 * `}` 没来得及吐出来。约束是尽力而为，这一层才是真正的防线。
 *
 * **绝不补全值，但允许丢弃末尾不完整元素后补结构性收尾括号**：给被截断的
 * JSON 补一对 `]}` 让已经完整的元素解出来，跟"编造模型没说完的话"是两码事——
 * 收尾括号本身不携带任何信息，被留下的每一个值都是模型原样吐出来的，下游
 * 还要逐字回证，编不出的东西根本混不进去。真正的红线是**零个完整元素时
 * 绝不修**：修成 `{"profiles":[]}` 等于把"模型输出坏了"重新伪装成"README
 * 里没有推荐参数"，这条红线不能让。
 */

export interface ExtractedJson {
  value: Record<string, unknown>;
  /** true = 原文是截断的，靠丢弃末尾不完整元素 + 补收尾括号才解出来 */
  repaired: boolean;
}

/**
 * 顶层必须是对象、且带一个数组类型的 `profiles` 键——这是 prompt 约定的唯一
 * 形状（见 `src/server/llm/prompt.ts`）。不认这条契约的后果：最外层 `{` 因
 * 截断解析失败时，逐 `{` 试探会退而抠到内层碎片（比如某一条 profile 自己的
 * `{"label":...,"params":{...}}`）——它自己是完整、合法的 JSON，却不是
 * prompt 要的答案，冒充成功返回后下游只会诊断成"模型没找到参数"，而真实
 * 原因是"模型的输出被截断了"，这比直接报错更具误导性。
 */
export function extractJson(raw: string): ExtractedJson | null {
  for (const candidate of collectCandidates(raw)) {
    const value = extractFromCandidate(candidate);
    if (value !== null) return { value, repaired: false };
  }

  const repaired = repairTruncated(raw);
  return repaired !== null ? { value: repaired, repaired: true } : null;
}

/**
 * 收集待扫描的候选文本：所有闭合围栏的内容（从后往前）+ 原始全文兜底。
 *
 * 从后往前：模型常见的输出形状是"先给一段示例围栏、再给正式结果围栏"，
 * 真正想要的答案在最后一段，示例段先试反而会把答案挡在后面。
 * 原始全文兜底放在最后：挡的是"围栏没有闭合"（比如被截断在围栏内部）
 * 这种输入——闭合围栏一个都收集不到时，仍然要能退回全文扫描找 JSON。
 */
function collectCandidates(raw: string): string[] {
  const fenceContents: string[] = [];
  const fenceRegex = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(raw)) !== null) {
    fenceContents.push(match[1]!.trim());
  }
  fenceContents.reverse();
  fenceContents.push(raw.trim());
  return fenceContents;
}

/**
 * 在一段候选文本里从左到右逐个 `{` 位置试探：配不上花括号、JSON.parse 失败、
 * 或过不了 profiles 契约检查，都不算数，跳到下一个 `{` 继续试，而不是直接
 * 放弃整段文本。
 */
function extractFromCandidate(text: string): Record<string, unknown> | null {
  let searchFrom = 0;

  for (;;) {
    const start = text.indexOf("{", searchFrom);
    if (start === -1) return null;

    const end = matchingBrace(text, start);
    if (end === -1) {
      searchFrom = start + 1;
      continue;
    }

    try {
      const parsed: unknown = JSON.parse(text.slice(start, end + 1));
      if (isProfilesShape(parsed)) return parsed;
    } catch {
      // 解析失败，跳到下一个 `{` 继续试，而不是整段放弃
    }
    searchFrom = start + 1;
  }
}

/** 契约检查：顶层是对象，且 `profiles` 键是数组 */
function isProfilesShape(parsed: unknown): parsed is Record<string, unknown> {
  return (
    parsed !== null &&
    typeof parsed === "object" &&
    Array.isArray((parsed as Record<string, unknown>).profiles)
  );
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

/**
 * 保守修复：所有候选都试完仍然没有合法结果时，最后再试一次——只处理
 * "`profiles` 数组被截断"这一种情形。算法：在 `"profiles"` 键后找到数组的
 * `[`，从数组内部逐字符扫描并维护深度，每当深度从 1 回落到 0 就说明刚好有
 * 一个数组元素完整闭合，记下这个位置；深度降到 -1 说明扫到了数组自己的
 * `]`，结构其实是完整的，停止扫描。
 *
 * 扫描结束后用"最后一个完整元素闭合的位置"截断原文、补上 `]}`，再解析、
 * 再过一遍 profiles 契约检查。**一个完整元素都没扫到就直接放弃，绝不修成
 * 空数组**——那等于把"模型输出坏了"伪装成"没找到"，正是本函数要消灭的缺陷。
 */
function repairTruncated(raw: string): Record<string, unknown> | null {
  const keyIndex = raw.indexOf('"profiles"');
  if (keyIndex === -1) return null;

  const arrayStart = raw.indexOf("[", keyIndex);
  if (arrayStart === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  let lastGoodEnd = -1;

  for (let i = arrayStart + 1; i < raw.length; i++) {
    const ch = raw[i]!;

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

    if (ch === "{" || ch === "[") {
      depth++;
    } else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) {
        lastGoodEnd = i + 1;
      } else if (depth === -1) {
        break;
      }
    }
  }

  if (lastGoodEnd === -1) return null;

  try {
    const parsed: unknown = JSON.parse(`${raw.slice(0, lastGoodEnd)}]}`);
    return isProfilesShape(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
