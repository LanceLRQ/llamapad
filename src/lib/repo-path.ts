/**
 * 仓库档案的路径推导与命名建议（纯逻辑层）。
 *
 * 档案的落盘目录是结构化的 `<base_dir>/<owner>/<repo>/`（设计 §2.1），这让
 * 「这个量化下过没有」变成一次精确的路径查询，而不是全盘比对文件名。本文件
 * 承担这套路径代数，vitest 是 environment: "node" 测不了组件，判定必须下沉。
 */

/** 与 server/fsScanner.ts 的 MAX_PATH_DEPTH 同值。此处重新声明而不是 import：
 * lib 是客户端组件也会引的层，反向依赖 server 会把 node 专用模块拖进浏览器
 * bundle。两处如需调整必须一起改。 */
const MAX_PATH_DEPTH = 8;

/**
 * 单个路径段合法：与 `app/api/v1/hf/repos/[id]/files/route.ts` 的 REPO_PATTERN
 * 同规则。这一条正则同时挡掉了三种我们特别在意的形态，不需要另外再判一遍：
 * 空段（`^[A-Za-z0-9]` 要求至少一个字符）、以点开头的段（会变成隐藏目录，
 * 被 scanTree 与 glob 一律跳过）、含斜杠反斜杠的段（字符集里没有）。
 */
function isValidSegment(seg: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(seg);
}

/** repo 形态：一段或多段 isValidSegment（HF 的 owner/name 即两段） */
export function isValidRepoId(repo: string): boolean {
  if (repo === "" || repo.startsWith("/") || repo.endsWith("/")) return false;
  return repo.split("/").every(isValidSegment);
}

/**
 * base 形态：允许空串（models 根）；否则每段与 repo 同规则。深度上限按
 * 「base 段数 + repo 最少 2 段」预留，超了在 repoTargetDir 阶段就无路可走。
 */
export function isValidBaseDir(baseDir: string): boolean {
  if (baseDir === "") return true;
  if (baseDir.startsWith("/") || baseDir.endsWith("/")) return false;
  const segs = baseDir.split("/");
  if (segs.length + 2 > MAX_PATH_DEPTH) return false;
  return segs.every(isValidSegment);
}

/** base + repo → 相对 models 根的落盘目录（base 为空串时就是 repo 本身） */
export function repoTargetDir(baseDir: string, repo: string): string {
  return baseDir === "" ? repo : `${baseDir}/${repo}`;
}

/**
 * 给定一个相对路径，若它落在某个档案目录内（或就是该目录本身），返回该目录；
 * 否则 null。用于两处守卫：URL 直链不得落进档案目录、档案内文件不得单独移动。
 *
 * 必须按目录边界判断而不是裸 startsWith —— `hf/o/R-extra/a.gguf` 的前缀
 * 匹配 `hf/o/R` 但它显然是另一个目录。
 */
export function repoDirOf(rel: string, repoDirs: readonly string[]): string | null {
  for (const dir of repoDirs) {
    if (rel === dir || rel.startsWith(`${dir}/`)) return dir;
  }
  return null;
}

/** 仓库基名：取最后一段并去掉 -GGUF / -gguf 后缀（HF 上 GGUF 仓库的普遍约定） */
function repoBaseName(repo: string): string {
  const last = repo.slice(repo.lastIndexOf("/") + 1);
  return last.replace(/[-_.]?GGUF$/i, "");
}

/**
 * 任意字符串 → modelSchema.name 允许的形态 `/^[a-z0-9][a-z0-9-]*$/`：小写、
 * 每段非字母数字并成单个连字符、去掉首尾连字符。
 *
 * 这三步之后首字符必然合法，不需要再补一道判断：所有非 [a-z0-9] 字符都已经
 * 变成连字符，而首部连字符又被去掉了，剩下的要么是空串（纯中文名一类，走
 * "model" 兜底），要么以字母数字开头。
 *
 * 导出给 wizard-autofill.ts 复用——「文件名 → 建议模型名」是同一条 slug 化
 * 规则，不能各写一份任其漂移。
 */
export function slugify(input: string): string {
  const slug = input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug === "" ? "model" : slug;
}

/** 建议模型名：`<仓库基名>-<量化>`，全部走 slugify 以满足 modelSchema.name */
export function suggestModelName(repo: string, quant: string): string {
  const base = repoBaseName(repo);
  return slugify(quant === "" ? base : `${base}-${quant}`);
}

/** 建议显示名：保留原始大小写，量化放括号（显示名无字符集约束） */
export function suggestDisplayName(repo: string, quant: string): string {
  const base = repoBaseName(repo);
  return quant === "" ? base : `${base} (${quant})`;
}
