/**
 * README 列表项里的 `key=value` 抽取（README 推荐参数抽取）
 *
 * 实测这条路比 CLI 块更重要：unsloth/Qwen3.8-27B-GGUF 整篇一个命令块都没有，
 * 推荐全在列表项里；而且列表项自带 thinking / non-thinking 的语义标签，
 * 分组质量比命令块高。
 *
 * 三条硬规则，每条都对着一个实测踩到的坑：
 *
 * 1. **只认 `=` 号型，不认冒号型**。规格表里满是 `Context Length: 262,144`、
 *    `Number of Layers: 64`，认冒号会把整片规格当成推荐。实测 12 个样本里
 *    没有一个用冒号型写推荐，这条限制零代价。
 * 2. **只认 markdown 列表项**。Qwen3.8 官方卡的评测方法学脚注里写着
 *    `temp=1.0, top_p=0.95`（在 HTML `<li>` 里），那是跑分配置不是推荐。
 * 3. **意图门控**：所属标题或前导句要命中推荐语义词，否则不收。
 *
 * label 的三级回落是这个模块最要紧的判断：unsloth 与 Qwen 官方的两套推荐
 * **同在一个 `## Best Practices` 标题下**，按标题取会得到两个一模一样的名字，
 * 用户根本没法选。所以先取行内冒号前缀，再取上方独立粗体行，最后才回落标题。
 *
 * 行内前缀的清洗是截断式的：前缀里真正的 label 只有一小段，其余是注解与
 * 引导语——`(or non-thinking) mode`、`, we suggest using`。所以在第一个
 * 括号/逗号/冒号处直接截断，只留左段。粗体独立行不走这条链（它整行就是
 * label，`Thinking mode (default)` 的括号必须保留）。
 */

export interface KvPair {
  /** README 原样键名（驼峰/下划线都保留，归一化是 readme-params 的事） */
  key: string;
  value: string;
}

export interface KvGroup {
  label: string;
  pairs: KvPair[];
  excerpt: string;
}

/** 推荐语义词：中英都要认 */
const INTENT = /recommend|suggest|best practice|settings|advise|optimal|推荐|建议/i;

/** `k=v`：键必须字母开头，值取到空白/逗号/反引号/右括号为止 */
const PAIR = /`?\b([A-Za-z][A-Za-z_-]{1,24})\s*=\s*([^\s,`)]+)`?/g;

const LIST_ITEM = /^\s*([-*+]|\d+\.)\s/;
/** 独立成行的粗体标题，如 `**Thinking mode (default):**` */
const BOLD_LINE = /^\s*\*\*(.+?):?\*\*\s*:?\s*$/;

const MAX_LABEL = 60;

/** 只清洗行内前缀；截断式——label 之后的内容（注解/引导语）直接扔掉 */
function cleanLabel(raw: string): string {
  return raw
    .replace(LIST_ITEM, "")
    .replace(/[`*_]/g, "")
    .split(/[（(]/)[0]
    .split(/[,，]/)[0]
    .split(/[:：]/)[0]
    .replace(/\b(use|using|for)\b\s*$/i, "")
    .trim()
    .slice(0, MAX_LABEL);
}

export function kvGroups(markdown: string): KvGroup[] {
  // 代码块整段挖掉：那是 readme-cli-block 的地盘，两边都收会产生重复
  const text = markdown.replace(/```[\s\S]*?```/g, "\n");
  const out: KvGroup[] = [];

  let heading = "";
  let intent = false;
  let boldLabel = "";
  let group: KvGroup | null = null;

  const flush = (): void => {
    if (group !== null && group.pairs.length > 0) out.push(group);
    group = null;
  };

  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/^\s*>\s?/, ""); // 剥 blockquote 前缀

    if (/^#{1,6}\s/.test(line)) {
      flush();
      heading = line.replace(/^#+\s*/, "").trim();
      intent = INTENT.test(heading);
      boldLabel = "";
      continue;
    }

    const bold = BOLD_LINE.exec(line);
    if (bold !== null) {
      flush();
      boldLabel = bold[1].trim();
      continue;
    }

    if (INTENT.test(line)) intent = true;
    if (line.trim() === "") continue; // 空行不打断组：列表项之间常有空行

    if (!LIST_ITEM.test(line)) {
      flush();
      continue;
    }

    PAIR.lastIndex = 0;
    const pairs = [...line.matchAll(PAIR)].map(([, key, value]) => ({ key, value }));
    if (pairs.length === 0 || (!intent && !INTENT.test(line))) {
      flush();
      continue;
    }

    const firstAt = line.indexOf(pairs[0].key);
    const own = cleanLabel(line.slice(0, firstAt));

    // 自带前缀 → 独立一套；无前缀的纯 `k=v` 行 → 并入当前组（HauhauCS 的 C3 形态）
    if (own !== "" || group === null) {
      flush();
      group = { label: own || boldLabel || heading, pairs: [], excerpt: line.trim().slice(0, 200) };
    }
    group.pairs.push(...pairs);
    if (own !== "") flush();
  }

  flush();
  return out;
}
