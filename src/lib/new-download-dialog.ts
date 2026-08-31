/**
 * 「新建下载」弹层的纯逻辑（批 6 任务 12）：三处入口共用同一个弹层组件，
 * 两个 Tab（HF 仓库 / URL 直链）各自的可提交判定与探测结果展示都下沉到
 * 这里配 .test.ts——vitest 是 environment: "node"，组件渲染测不了。
 *
 * `repoDirOf` / `repoTargetDir` / `isValidRepoId` / `isValidBaseDir` 来自
 * lib/repo-path.ts，`withRootFolder` / `pickDefaultFolder` 来自
 * lib/wizard-target-dir.ts，两处都是前序任务已经提供的判定，这里只
 * 复用不重写。
 */
import { isValidBaseDir, isValidRepoId, repoDirOf, repoTargetDir } from "./repo-path";
import { pickDefaultFolder, withRootFolder } from "./wizard-target-dir";

/** HF 仓库 baseDir 下拉的默认建议值（设计约定：HF 仓库统一先归到 hf/ 下，
 *  用户仍可通过下拉改选任意其他目录或根目录） */
export const DEFAULT_REPO_BASE_DIR = "hf";

/**
 * baseDir 下拉候选：在磁盘现有目录基础上，保证默认值 `hf` 与根目录都在场——
 * 两者都可能在全新安装时还不存在于磁盘上（scanTree 只收录已存在的目录），
 * 但作为可选目的地必须始终可选，用户选中后由 createProfile 的 mkdirSync
 * 负责真正建出来。
 */
export function repoBaseDirOptions(folders: readonly string[]): string[] {
  const withDefault = folders.includes(DEFAULT_REPO_BASE_DIR)
    ? [...folders]
    : [DEFAULT_REPO_BASE_DIR, ...folders];
  return withRootFolder(withDefault);
}

/** 与 POST /api/v1/repos/probe 响应形状对齐的最小子集（组件只需要这两个字段） */
export interface RepoProbeResult {
  existing: { id: number; targetDir: string }[];
  orphans: string[];
}

export type RepoProbeDisplay =
  | { kind: "empty" }
  | { kind: "invalid" }
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "exists"; targetDir: string; id: number }
  | { kind: "orphan"; targetDir: string }
  | { kind: "clear" };

/**
 * 探测结果 → 展示状态。核心取舍：探测是「失焦触发」的一次性提示，不是提交
 * 前置条件——`result === null`（还没探测过）或 `probedRepo` 与当前 repo 不
 * 一致（探测完成后用户又改了输入，还没来得及重新失焦）时一律退回 `clear`，
 * 既不假装命中、也不阻断提交；最终裁决永远留给服务端（CONFLICT/INVALID_NAME）。
 *
 * `exists` 的命中要求 targetDir 精确等于 `repoTargetDir(baseDir, repo)`——
 * 同一个 repo 可能已经挂在别的 baseDir 下（探测按 repo 全局查，不看 baseDir），
 * 那种情况不阻断在当前 baseDir 下再建一份。
 */
export function resolveRepoProbeDisplay(params: {
  repo: string;
  baseDir: string;
  phase: "idle" | "loading" | "error";
  result: RepoProbeResult | null;
  probedRepo: string | null;
}): RepoProbeDisplay {
  const trimmed = params.repo.trim();
  if (trimmed === "") return { kind: "empty" };
  if (!isValidRepoId(trimmed)) return { kind: "invalid" };
  if (params.phase === "loading") return { kind: "loading" };
  if (params.phase === "error" && params.probedRepo === trimmed) return { kind: "error" };
  if (params.result === null || params.probedRepo !== trimmed) return { kind: "clear" };

  const targetDir = repoTargetDir(params.baseDir, trimmed);
  const hit = params.result.existing.find((p) => p.targetDir === targetDir);
  if (hit !== undefined) return { kind: "exists", targetDir, id: hit.id };
  if (params.result.orphans.includes(targetDir)) return { kind: "orphan", targetDir };
  return { kind: "clear" };
}

/** HF 仓库 Tab 的提交闸门：格式非法/探测中/已存在时禁用，孤儿与探测失败
 *  不拦——那两种都允许提交，由服务端做最终裁决。 */
export function repoSubmitDisabled(display: RepoProbeDisplay, baseDir: string, busy: boolean): boolean {
  if (busy) return true;
  if (display.kind === "empty" || display.kind === "invalid" || display.kind === "loading") return true;
  if (display.kind === "exists") return true;
  if (!isValidBaseDir(baseDir)) return true;
  return false;
}

/** 下载链接格式校验：只收 http/https——GGUF 直链下载走 fetch，其余协议
 *  在这层拦掉比等服务端 fetch 抛错更早给出反馈。 */
export function isValidDownloadUrl(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "") return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** 文件名输入框留空时不传给服务端，由服务端按 URL 末段派生（route.ts 里
 *  已有的兜底逻辑），这里只负责把"纯空白"归一成 undefined。 */
export function normalizeFilename(filename: string): string | undefined {
  const trimmed = filename.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** URL 直链 Tab 的提交闸门：URL 格式与档案目录守卫都在前端先挡一道，
 *  服务端 downloads/direct route 有同款 repoDirOf 检查兜底真正的裁决。 */
export function urlSubmitDisabled(
  url: string,
  targetDir: string,
  repoDirs: readonly string[],
  busy: boolean,
): boolean {
  if (busy) return true;
  if (!isValidDownloadUrl(url)) return true;
  if (repoDirOf(targetDir, repoDirs) !== null) return true;
  return false;
}

/**
 * URL Tab 目标目录初始值：文件页唤起时带着 `defaultBaseDir`（当前浏览的
 * 文件夹，含根目录空串），其余入口落回 pickDefaultFolder 的既有默认逻辑
 * （向导「存放位置」同款）。`??` 而非 `||`——空串是合法的根目录，不能被
 * 当成"没传"退回默认值。
 */
export function initialUrlTargetDir(defaultBaseDir: string | undefined, folders: readonly string[]): string {
  return defaultBaseDir ?? pickDefaultFolder(folders);
}
