/**
 * 字面回证：LLM 给出的值能否在 README 原文里找到（README 推荐参数的 LLM 解析，批 3）
 *
 * **这是 LLM 抽取唯一的可信性闸门。** 命中才留，不命中一律丢弃。它把「模型编造一个
 * 看起来很合理的 temp=0.7」这类幻觉压到接近 0——编出来的值不可能恰好出现在原文里。
 *
 * 双通道，**都不做单位换算**：
 * - 数值：把原文扫成数字 token 逐个做数值相等。刻意不用字符串 includes——
 *   `"0.6"` 是 `"10.65"` 的子串，用 includes 会把一个完全无关的数字认成命中，
 *   而这正是闸门最不能出的错
 * - 字符串 / 布尔：归一化（小写、去首尾空白）后原样 includes
 *
 * `32k → 32768` 这类换算属于「解释」而非「抽取」，且 32k 到底是 32000 还是 32768
 * 从文本本身判不出来，一律不做。
 */

/** 命中句硬上限，与 readme-params.ts 的 excerpt 同口径 */
const MAX_SENTENCE = 200;

/** 千分位逗号、可选小数、可选负号 */
const NUMBER_TOKEN = /-?\d+(?:,\d{3})*(?:\.\d+)?/g;

/**
 * 左边界拒绝集合：数字 token 前一个字符若是它们之一，说明这串数字不是独立的值，
 * 而是更长标识符的一截——挡两类真实 README 形状：
 * - 连字符紧贴在词字符后面时不是负号，是分隔符：`2024-01-15` 里的 `-01`、
 *   `Llama-3.1-8B` 里的 `-8`，正则的 `-?` 会把它们当成负数抓进来
 * - 数字紧贴在词字符 / 逗号 / 句点后面时是标识符的一部分：`Q4_K_M` 的 `4`、
 *   `32,768` 里被逗号截断后单独出现的位数、`1.0.5` 这种版本号里点号后的下一段
 */
const LEFT_BOUNDARY_REJECT = /[\w.,-]/;

/**
 * 右边界拒绝集合：数字 token 后一个字符若是它们之一，同样说明不是独立的值——
 * 挡 `8B`、`32k` 这类单位后缀，以及 `0.5-0.7` 范围写法里紧跟在前一段数字后面的连字符
 * （原文只写了范围、没写具体值时，中间值不应算命中）
 */
const RIGHT_BOUNDARY_REJECT = /[\w-]/;

/**
 * 判断数字 token 的左右是否为独立数值的边界。
 *
 * 右边界有一条例外：紧跟的字符是句点、且句点后面还是数字，说明这是 `1.0.5`
 * 这类版本号里点号分隔的下一段，仍要拒绝；但句末的 `0.6.`——句点后面不是数字而是
 * 空白或结尾——不能被这条例外误伤，那是一句话正常收尾的句号。
 */
function hasNumberBoundary(body: string, start: number, end: number): boolean {
  const before = body[start - 1];
  if (before !== undefined && LEFT_BOUNDARY_REJECT.test(before)) return false;

  const after = body[end];
  if (after !== undefined) {
    if (RIGHT_BOUNDARY_REJECT.test(after)) return false;
    if (after === "." && /\d/.test(body[end + 1] ?? "")) return false;
  }
  return true;
}

/** 句末标点（英文句点单独判：要求后面跟空白或结尾，免得把 v1.5 里的点当句号） */
const HARD_BREAK = "\n。！？!?";

function isBreak(body: string, i: number): boolean {
  const ch = body[i];
  if (ch === undefined) return false;
  if (HARD_BREAK.includes(ch)) return true;
  return ch === "." && /\s|^$/.test(body[i + 1] ?? "");
}

export interface VerifyHit {
  /** 命中所在的整句原文，≤200 字符 */
  sentence: string;
}

/** 从命中位置向两侧扩到句边界，再 trim 并截断 */
function sentenceAt(body: string, index: number, length: number): string {
  let start = 0;
  let end = body.length;

  for (let i = index - 1; i >= 0; i--) {
    if (isBreak(body, i)) {
      start = i + 1;
      break;
    }
  }
  for (let i = index + length; i < body.length; i++) {
    if (isBreak(body, i)) {
      // 换行本身不属于句子，标点属于
      end = body[i] === "\n" ? i : i + 1;
      break;
    }
  }

  const sentence = body.slice(start, end).trim();
  if (sentence.length <= MAX_SENTENCE) return sentence;

  // 超长时以命中点为中心截取，保证命中的那个值本身留在窗口里——
  // 截出一段不含被回证值的原文，对用户毫无核对价值
  const center = index - start;
  const half = Math.floor(MAX_SENTENCE / 2);
  const from = Math.max(0, Math.min(center - half, sentence.length - MAX_SENTENCE));
  return sentence.slice(from, from + MAX_SENTENCE).trim();
}

function verifyNumber(value: number, body: string): VerifyHit | null {
  if (!Number.isFinite(value)) return null;
  NUMBER_TOKEN.lastIndex = 0;
  for (let m = NUMBER_TOKEN.exec(body); m !== null; m = NUMBER_TOKEN.exec(body)) {
    if (!hasNumberBoundary(body, m.index, m.index + m[0].length)) continue;
    if (Number(m[0].replace(/,/g, "")) === value) {
      return { sentence: sentenceAt(body, m.index, m[0].length) };
    }
  }
  return null;
}

function verifyText(value: string, body: string): VerifyHit | null {
  const needle = value.trim().toLowerCase();
  if (needle === "") return null;
  const index = body.toLowerCase().indexOf(needle);
  return index === -1 ? null : { sentence: sentenceAt(body, index, needle.length) };
}

/** 命中返回命中句，不命中返回 null。调用方据此决定留下还是丢弃这个字段。 */
export function verifyValue(value: unknown, body: string): VerifyHit | null {
  if (body === "") return null;
  if (typeof value === "number") return verifyNumber(value, body);
  if (typeof value === "boolean") return verifyText(String(value), body);
  if (typeof value === "string") return verifyText(value, body);
  return null;
}
