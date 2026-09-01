import type Database from "better-sqlite3";
import { repoTargetDir } from "../lib/repo-path";

/**
 * 档案目录清单（批 3 第 4 项）：独立成一个模块，不挂在 filesApi.ts /
 * repoProfiles.ts / folders.ts 任一个之下——这三者已经互相依赖
 * （folders.ts 依赖 filesApi.ts 的 assertFolderInsideRoot/buildRefMap，
 * repoProfiles.ts 依赖 filesApi.ts 的 buildRefMap 与 folders.ts 的
 * renameFolder），谁反向 import 谁都会成环。本模块只依赖 better-sqlite3
 * 类型与 lib/repo-path 的 repoTargetDir，四处都能安全 import 而不必担心成环，
 * 也不会自己变成新的环的一部分。
 *
 * 返回值是相对 models 根的档案目录路径（repoTargetDir(base_dir, repo) 的
 * 结果）。典型用法是配合 lib/repo-path 的 repoDirOf / findBlockingRepoDir：
 * `repoDirOf(rel, listRepoDirs(db))` 判定某个相对路径是否落在任一档案目录
 * 内（或就是该目录本身）。
 *
 * 此前这段查询在 filesApi.ts 的 planFileMove / planFileRename 里各抄了
 * 一份逐字重复的实现；本批第 1、2 项新增的守卫又要各用一次——四处各写一遍
 * 裸查询，以后档案目录的推导规则一变（比如加 source 列过滤、改成读缓存）
 * 会改一处漏一处，出现"移动被拦、改名放行"这种半边守卫的状态。
 */
export function listRepoDirs(db: Database.Database): string[] {
  return (
    db.prepare("SELECT base_dir, repo FROM model_repos").all() as {
      base_dir: string;
      repo: string;
    }[]
  ).map((r) => repoTargetDir(r.base_dir, r.repo));
}
