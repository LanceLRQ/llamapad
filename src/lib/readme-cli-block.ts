/**
 * README 里 llama.cpp 命令行的分词（README 推荐参数抽取）
 *
 * **只做分词，不碰语义**：产出的 flag 保持 README 原样（`--temp` / `-ngl` /
 * `--repeat_penalty` 老写法都原封不动），映射到配置字段是 lib/readme-params.ts
 * 的职责。两件事分开，是因为「命令行怎么切」和「这个参数叫什么」各自的边界情况
 * 完全不同，混在一起两边都测不干净。
 *
 * 依据：docs/_internal/research/2026-09-02-readme样本/ 的 12 份真实 README。
 * 四个发布者四种写法（HauhauCS 的 `\` 续行、unsloth 的 tab 缩进续行、
 * Qwen 官方的单行长命令、TheBloke 的老 `./main`），都在用例里。
 */

export interface CliFlag {
  /** README 里的原样写法，含前导横线 */
  flag: string;
  /** 参数值；无值开关为空串 */
  value: string;
}

export interface CliFlagGroup {
  flags: CliFlag[];
  /** 原始命令行，供 UI 展示「出处」 */
  excerpt: string;
}

/** 只认这几种代码块语言：python/json/bibtex/txt 里的等号不是命令行参数 */
const SHELL_LANGS = new Set(["", "bash", "sh", "shell", "console", "zsh"]);

/** 命令块的判定特征：三种可执行名都要认（老版本叫 main） */
const LLAMA_COMMAND = /llama-(cli|server)|\.\/main\b/;

const FENCE = /```([a-zA-Z]*)\n([\s\S]*?)```/g;

/** 分词：引号内整体成一个 token，其余按空白切 */
function tokenize(line: string): string[] {
  return line.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
}

export function cliFlagGroups(markdown: string): CliFlagGroup[] {
  const groups: CliFlagGroup[] = [];
  let match: RegExpExecArray | null;
  FENCE.lastIndex = 0;

  while ((match = FENCE.exec(markdown)) !== null) {
    const [, lang, body] = match;
    if (!SHELL_LANGS.has(lang.toLowerCase())) continue;
    if (!LLAMA_COMMAND.test(body)) continue;

    // 续行合并要在按行切之前做，否则每个 `\` 结尾的片段都成了独立行
    const joined = body.replace(/\\\s*\n\s*/g, " ");
    for (const line of joined.split("\n")) {
      if (!LLAMA_COMMAND.test(line)) continue;

      const tokens = tokenize(line);
      const flags: CliFlag[] = [];
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (!token.startsWith("-")) continue;

        if (token.includes("=")) {
          const [flag, ...rest] = token.split("=");
          flags.push({ flag, value: rest.join("=") });
          continue;
        }
        const next = tokens[i + 1];
        // 下一个 token 以 `-` 开头通常是另一个参数，但负数是值
        // （TheBloke 的 `-n -1` 实测会踩到这条）
        const isValue = next !== undefined && (!next.startsWith("-") || /^-\d/.test(next));
        flags.push({ flag: token, value: isValue ? next : "" });
        if (isValue) i++;
      }
      if (flags.length > 0) groups.push({ flags, excerpt: line.trim().slice(0, 200) });
    }
  }
  return groups;
}
