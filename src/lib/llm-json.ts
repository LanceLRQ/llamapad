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

/**
 * 顶层必须是对象：数组无法承载 profiles 之外的元信息，也不是 prompt 约定的形状。
 *
 * 抠取策略是「候选列表 + 逐个试」而不是「抓第一个花括号」：散文里常见装饰性的
 * `{}`（比如"用 {} 表示占位符"），如果只取第一个花括号，这种空壳会把它后面
 * 真正的 JSON 挡住、还被当成合法结果返回——下游会诊断成"模型没找到参数"，
 * 而真实原因是"模型的输出根本没被读到"，这比直接返回 null 更具误导性。
 */
export function extractJson(raw: string): Record<string, unknown> | null {
  for (const candidate of collectCandidates(raw)) {
    const result = extractFromCandidate(candidate);
    if (result !== null) return result;
  }
  return null;
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
 * 或解出来是空对象，都不算数，跳到下一个 `{` 继续试，而不是直接放弃整段文本。
 *
 * 空对象 `{}` 一律不算可用结果：模型真要表达"什么都没找到"，按 prompt 契约
 * 会给 `{"profiles":[]}`（有键、可用）；一个光秃秃的 `{}` 只可能来自散文里的
 * 装饰花括号或被截断的残骸，认它就是把"抠不出就返回 null"这条红线让掉了。
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
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        Object.keys(parsed).length > 0
      ) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // 解析失败，跳到下一个 `{` 继续试，而不是整段放弃
    }
    searchFrom = start + 1;
  }
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
