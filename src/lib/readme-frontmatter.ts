import { parse as parseYaml } from "yaml";

/**
 * README frontmatter 剥离（HF README 视图）
 *
 * HF 的模型卡开头几乎都有一段 YAML frontmatter（license / base_model / tags…）。
 * 不剥的话 react-markdown 会把 `---` 当成 setext 标题的下划线或水平线，渲染出
 * 一堆错位的大标题——它不是正文，是元数据。
 *
 * **只剥开头那一对**：正文中间的 `---` 是作者写的分隔线（调研语料里
 * unsloth/Qwen3.8-27B-GGUF 的正文中就有一条），动它就是改坏别人的文档。
 */

/** 展示用徽章：key 交给 i18n 取标签，value 已拼成字符串 */
export interface FrontmatterBadge {
  key: "license" | "base_model" | "pipeline_tag" | "tags";
  value: string;
}

export interface FrontmatterSplit {
  /** 解析成功且是映射时给出；其余情况一律 null（坏 YAML 不抛） */
  meta: Record<string, unknown> | null;
  /** 剥离后的正文；未命中 frontmatter 时与入参逐字节相同 */
  body: string;
}

/** 徽章展示顺序：证照 → 基座 → 任务类型 → 标签，从「最该先看」排到「可选」 */
const BADGE_KEYS = ["license", "base_model", "pipeline_tag", "tags"] as const;

/** tags 最多展示 6 个——再多会把徽章行挤成一堵墙，信息价值反而下降 */
const MAX_TAGS = 6;

export function splitFrontmatter(raw: string): FrontmatterSplit {
  if (!raw.startsWith("---\n") && !raw.startsWith("---\r\n")) {
    return { meta: null, body: raw };
  }

  const lines = raw.split("\n");
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  // 未闭合：整段都不是 frontmatter，原样返回（吞掉正文比不剥严重得多）
  if (end === -1) return { meta: null, body: raw };

  const frontmatterContent = lines.slice(1, end).join("\n");
  let parsed: unknown;
  let parseFailed = false;
  try {
    parsed = parseYaml(frontmatterContent);
  } catch {
    parsed = null;
    parseFailed = true; // 记录解析失败（坏 YAML）
  }

  const isMapping = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  const body = lines
    .slice(end + 1)
    .join("\n")
    .replace(/^\r?\n/, ""); // 闭合行后常跟一个空行，一并吃掉

  // 解析结果不是映射时的处理：
  // 1. 解析失败（parseFailed）→ 剥 frontmatter，返回 body（坏 YAML 不抛）
  // 2. 解析成功但不是映射 → 水平线，原样返回 raw
  // 3. 解析结果是 null → 判断 frontmatterContent 是否全空：
  //    - 全空 → 算 frontmatter（空内容），返回 body
  //    - 非空 → 水平线（YAML 库把正文解析成了 null），原样返回 raw
  if (!isMapping) {
    if (parseFailed) {
      // 坏 YAML，不抛异常，直接剥掉返回 body
      return { meta: null, body };
    }
    if (parsed === null) {
      // frontmatter 全空或只有空白 → 算空 frontmatter
      const isEmpty = /^\s*$/.test(frontmatterContent);
      return { meta: null, body: isEmpty ? body : raw };
    }
    // 解析成功但不是映射（如数组、字符串等）→ 水平线
    return { meta: null, body: raw };
  }

  return { meta: parsed as Record<string, unknown>, body };
}

/** 单值取字符串：HF 的 base_model 有裸字符串与单元素数组两种写法，都要认 */
function firstString(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (Array.isArray(value)) {
    const hit = value.find((v) => typeof v === "string" && v.trim() !== "");
    return typeof hit === "string" ? hit.trim() : null;
  }
  return null;
}

export function frontmatterBadges(meta: Record<string, unknown> | null): FrontmatterBadge[] {
  if (meta === null) return [];
  const badges: FrontmatterBadge[] = [];
  for (const key of BADGE_KEYS) {
    if (key === "tags") {
      const raw = meta.tags;
      if (!Array.isArray(raw)) continue;
      const tags = raw.filter((t): t is string => typeof t === "string" && t.trim() !== "");
      if (tags.length === 0) continue;
      const shown = tags.slice(0, MAX_TAGS).join(", ");
      badges.push({ key, value: tags.length > MAX_TAGS ? `${shown}…` : shown });
      continue;
    }
    const value = firstString(meta[key]);
    if (value !== null) badges.push({ key, value });
  }
  return badges;
}
