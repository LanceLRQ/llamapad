import type Database from "better-sqlite3";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isValidBaseDir, isValidRepoId, repoTargetDir } from "../lib/repo-path";
import { buildRefMap } from "./filesApi";
import { MAX_PATH_DEPTH } from "./fsScanner";
import { renameFolder } from "./folders";

/**
 * 仓库档案服务层（设计 §6）。
 *
 * 档案 = DB 行 + 目录内隐藏标记文件的双真源：DB 让列表页零 IO，标记文件让整个
 * 目录被手动搬走后仍能被 scanRepoMarkers 找回来认领。标记文件以点开头，
 * fsScanner 的隐藏项跳过规则让它不会污染文件页列表（既有行为，无需改动）。
 *
 * 注意命名：server/repo/models.ts 已有 ModelRepo 类型（模型仓储接口），档案
 * 一律用 RepoProfile，不得复用那个名字。
 */

/** 档案目录内的标记文件名（点开头 → scanTree 与 glob 一律跳过） */
export const REPO_MARKER_FILENAME = ".llamapad-repo";

export type RepoProfileErrorCode = "INVALID_NAME" | "NOT_FOUND" | "CONFLICT" | "LOCKED";

export class RepoProfileError extends Error {
  constructor(
    readonly code: RepoProfileErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RepoProfileError";
  }
}

/** 错误码 → HTTP 状态，与 folders.ts / filesApi.ts 的既有契约一致 */
export function repoProfileErrorStatus(code: RepoProfileErrorCode): number {
  switch (code) {
    case "NOT_FOUND":
      return 404;
    case "LOCKED":
      return 423;
    default:
      return 400;
  }
}

export interface RepoProfile {
  id: number;
  repo: string;
  baseDir: string;
  /** 派生字段：repoTargetDir(baseDir, repo)，调用方不必自己拼 */
  targetDir: string;
  createdAt: number;
}

export interface RepoProfileDeps {
  db: Database.Database;
  /** 面板视角 models 根：存在性判断与 buildRefMap 用 */
  modelsRoot: string;
  /** 宿主视角 models 根：mkdir/rm 落盘用（生产环境两根可能不同，见 folders.ts） */
  hostRoot: string;
  /** 当前运行模型名（无则 null），用于 LOCKED 判定 */
  runningModel: string | null;
}

interface Row {
  id: number;
  repo: string;
  base_dir: string;
  created_at: number;
}

function toProfile(row: Row): RepoProfile {
  return {
    id: row.id,
    repo: row.repo,
    baseDir: row.base_dir,
    targetDir: repoTargetDir(row.base_dir, row.repo),
    createdAt: row.created_at,
  };
}

export function listProfiles(db: Database.Database): RepoProfile[] {
  const rows = db.prepare("SELECT * FROM model_repos ORDER BY id").all() as Row[];
  return rows.map(toProfile);
}

export function getProfile(db: Database.Database, id: number): RepoProfile | null {
  const row = db.prepare("SELECT * FROM model_repos WHERE id = ?").get(id) as Row | undefined;
  return row === undefined ? null : toProfile(row);
}

export interface CreateProfileArgs {
  repo: string;
  baseDir: string;
}

export interface CreatedProfile extends RepoProfile {
  /** true 表示目录本来就在（认领既有文件），false 表示新建了空目录 */
  claimed: boolean;
}

/**
 * 新建或认领档案。
 *
 * 目录已存在但没有标记文件时**也认领**（补写标记），不报 CONFLICT：目录名要
 * 恰好等于 `<base>/<owner>/<repo>` 这样的多级路径，巧合概率为零 —— 它必然是
 * 用户手动按约定放的，或是删档案时选了「保留文件」留下的。拒绝只会制造一条
 * 死路（既不能认领，又不能用这个 base 建档案）。
 */
export function createProfile(deps: RepoProfileDeps, args: CreateProfileArgs): CreatedProfile {
  const { db, modelsRoot, hostRoot } = deps;
  const { repo, baseDir } = args;

  if (!isValidRepoId(repo)) {
    throw new RepoProfileError("INVALID_NAME", `INVALID_NAME: 仓库 ID 非法: ${repo}`);
  }
  if (!isValidBaseDir(baseDir)) {
    throw new RepoProfileError("INVALID_NAME", `INVALID_NAME: 存放目录非法: ${baseDir}`);
  }
  const dir = repoTargetDir(baseDir, repo);
  if (dir.split("/").length > MAX_PATH_DEPTH) {
    throw new RepoProfileError(
      "INVALID_NAME",
      `INVALID_NAME: 落盘目录层级超过上限（${MAX_PATH_DEPTH} 层）: ${dir}`,
    );
  }

  const dup = db
    .prepare("SELECT id FROM model_repos WHERE base_dir = ? AND repo = ?")
    .get(baseDir, repo);
  if (dup !== undefined) {
    throw new RepoProfileError("CONFLICT", `CONFLICT: 该仓库在此目录下已有档案: ${dir}`);
  }

  const abs = join(modelsRoot, dir);
  const claimed = existsSync(abs);
  mkdirSync(join(hostRoot, dir), { recursive: true });
  writeFileSync(
    join(hostRoot, dir, REPO_MARKER_FILENAME),
    `${JSON.stringify({ repo, createdAt: Date.now() }, null, 2)}\n`,
  );

  const now = Date.now();
  const info = db
    .prepare("INSERT INTO model_repos(repo, base_dir, created_at) VALUES (?, ?, ?)")
    .run(repo, baseDir, now);
  return {
    id: Number(info.lastInsertRowid),
    repo,
    baseDir,
    targetDir: dir,
    createdAt: now,
    claimed,
  };
}

/**
 * 全盘找标记文件。递归下降到 MAX_PATH_DEPTH 为止；命中标记文件的目录不再往下
 * 找（档案目录内部不会再嵌套档案）。用于新建时的复用提示与孤儿目录认领。
 */
export function scanRepoMarkers(modelsRoot: string): { dir: string; repo: string }[] {
  const found: { dir: string; repo: string }[] = [];

  function walk(rel: string, depth: number): void {
    if (depth > MAX_PATH_DEPTH) return;
    const abs = rel === "" ? modelsRoot : join(modelsRoot, rel);
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return; // 权限不足 / 竞态删除：跳过该子树，不让整次扫描失败
    }

    const marker = entries.find((e) => e.isFile() && e.name === REPO_MARKER_FILENAME);
    if (marker !== undefined && rel !== "") {
      try {
        const raw = JSON.parse(readFileSync(join(abs, REPO_MARKER_FILENAME), "utf8")) as {
          repo?: unknown;
        };
        if (typeof raw.repo === "string") found.push({ dir: rel, repo: raw.repo });
      } catch {
        // 标记文件损坏：当作普通目录，继续往下扫
      }
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      walk(rel === "" ? entry.name : `${rel}/${entry.name}`, depth + 1);
    }
  }

  walk("", 1);
  return found;
}

export interface DeleteProfileArgs {
  id: number;
  /** true 递归删掉整个目录；false（默认）只删 DB 行与标记文件 */
  deleteFiles: boolean;
}

export interface DeleteProfileResult {
  /** 删除的档案目录 */
  targetDir: string;
  filesDeleted: boolean;
}

/**
 * 删除档案。三层语义与「删除模型」对齐：默认只解除管理关系（目录降级为普通
 * 文件夹），显式要求才动文件；有配置引用目录内文件时拒绝删文件并列出配置名。
 */
export function deleteProfile(
  deps: RepoProfileDeps,
  args: DeleteProfileArgs,
): DeleteProfileResult {
  const { db, modelsRoot, hostRoot } = deps;
  const profile = getProfile(db, args.id);
  if (profile === null) {
    throw new RepoProfileError("NOT_FOUND", `NOT_FOUND: 档案不存在: ${args.id}`);
  }

  const unfinished = db
    .prepare(
      `SELECT COUNT(*) AS c FROM download_tasks
       WHERE repo_id = ? AND status IN ('pending', 'downloading', 'paused')`,
    )
    .get(args.id) as { c: number };
  if (unfinished.c > 0) {
    throw new RepoProfileError("LOCKED", `LOCKED: 该档案有 ${unfinished.c} 个未完成的下载任务`);
  }

  if (args.deleteFiles) {
    const referrers = new Set<string>();
    for (const [rel, refs] of buildRefMap(db, modelsRoot)) {
      if (rel === profile.targetDir || rel.startsWith(`${profile.targetDir}/`)) {
        for (const ref of refs) referrers.add(ref.modelName);
      }
    }
    if (referrers.size > 0) {
      throw new RepoProfileError(
        "LOCKED",
        `LOCKED: 目录内文件仍被配置引用: ${[...referrers].join(", ")}`,
      );
    }
    rmSync(join(hostRoot, profile.targetDir), { recursive: true, force: true });
  } else {
    const marker = join(hostRoot, profile.targetDir, REPO_MARKER_FILENAME);
    if (existsSync(marker)) unlinkSync(marker);
  }

  db.prepare("DELETE FROM model_repos WHERE id = ?").run(args.id);
  return { targetDir: profile.targetDir, filesDeleted: args.deleteFiles };
}

export interface MoveProfileArgs {
  id: number;
  toBaseDir: string;
}

export interface MoveProfileResult {
  from: string;
  to: string;
  renamed: number;
}

/**
 * 换存放位置 = 整个 `<base>/<owner>/<repo>/` 目录搬到新 base。
 *
 * 直接复用 renameFolder —— 它上一批已支持多级路径，物理 mv + gguf_file /
 * mmproj_file 引用重写 + file_meta 迁移全是现成的，这里只补一句档案表更新。
 * 标记文件跟着目录走，内容不用改（它只记 repo，不记位置）。
 */
export function moveProfile(deps: RepoProfileDeps, args: MoveProfileArgs): MoveProfileResult {
  const { db, modelsRoot, hostRoot, runningModel } = deps;
  const profile = getProfile(db, args.id);
  if (profile === null) {
    throw new RepoProfileError("NOT_FOUND", `NOT_FOUND: 档案不存在: ${args.id}`);
  }
  if (!isValidBaseDir(args.toBaseDir)) {
    throw new RepoProfileError("INVALID_NAME", `INVALID_NAME: 存放目录非法: ${args.toBaseDir}`);
  }
  if (args.toBaseDir === profile.baseDir) {
    throw new RepoProfileError("INVALID_NAME", `INVALID_NAME: 目标目录与当前相同`);
  }

  const to = repoTargetDir(args.toBaseDir, profile.repo);
  const result = renameFolder(
    { db, modelsRoot, hostRoot, runningModel },
    { from: profile.targetDir, to },
  );
  db.prepare("UPDATE model_repos SET base_dir = ? WHERE id = ?").run(args.toBaseDir, args.id);
  return { from: profile.targetDir, to, renamed: result.renamed };
}
