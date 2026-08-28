import type Database from "better-sqlite3";
import { renameSync } from "node:fs";
import { createModelRepo } from "./repo/models";

/**
 * 文件移动 + 引用重写的事务原语（设计 §2.1，`docs/_internal/features/
 * 2026-08-28-文件管理与镜像管理-design.md`）。供 `namespaces.moveModel` 与
 * 后续文件页的移动/改名共用。
 *
 * 职责边界：只管"物理移动 + 引用重写"这一组事务性操作本身，不管权限判断、
 * LOCKED/REFERENCED 之类的交互确认——那些由调用方在拿到 plan 前完成（plan
 * 里已经是算好的最终结果）。
 *
 * 执行顺序（不可逆，无两阶段 mv）：
 * 1. 按 from/to 下标一一对应逐个 renameSync（host 视角绝对路径）
 * 2. 全部 rename 成功后，在单个 db.transaction() 内批量重写 refUpdates，
 *    保证「N 个模型的字段要么全部更新、要么全不更新」
 *
 * file_meta 联动（设计 §3）：登记 file_meta 的 listFileMeta 修复后，
 * file_meta.path 恒等于模型配置 gguf_file/mmproj_file 字段的原始值，因此
 * refUpdates 里重写这两个字段时，同名的 file_meta 行需要跟着迁移——在覆盖
 * 字段值之前读一次旧值即可拿到"从哪迁到哪"，不需要调用方另算一遍传进来。
 * 迁移执行与 refUpdates 同在这个事务内，同生共死。放在这个原语里而不是各
 * 调用方分别处理，是因为所有移动都收敛到这一处，不会有调用方（现在或将来
 * 新增的）漏做这一步。
 *
 * 失败处理（沿用现状取舍，不做自动回滚补偿）：rename 全部成功但事务抛错时，
 * 文件已经在新位置、DB 仍指旧路径——抛 FileMoveError 明确告知"文件已移动、
 * 配置未更新，请重试或手动核对"。不做两阶段 mv：真实失败源通常是校验类的
 * 确定性错误，重试无用，需要人工核对；为收窄的失败窗口引入回滚补偿与新增
 * 复杂度不成比例。
 */

/**
 * refUpdates 允许改写的字段。除两个文件路径字段外额外收纳 namespace——
 * 发起移动的模型自身既要挪 namespace 又要重写路径字段，两者必须在同一事务
 * 内同生共死，否则会出现"namespace 已变、路径未变"（或反过来）的新中间态。
 */
export type RefUpdateField = "gguf_file" | "mmproj_file" | "namespace";

/** 一条引用重写：哪个模型、哪个字段、改写成什么值 */
export interface RefUpdate {
  modelName: string;
  field: RefUpdateField;
  nextValue: string;
}

/** moveFiles 的执行计划：调用方算好，本文件只负责按计划执行 */
export interface MoveFilesPlan {
  /** 待移动文件的当前绝对路径（host 视角），与 to 按下标一一对应 */
  from: string[];
  /** 目标绝对路径（host 视角），与 from 按下标一一对应 */
  to: string[];
  /** 需要重写的全部模型字段（含发起移动的模型自身），单事务批量写入 */
  refUpdates: RefUpdate[];
}

export interface MoveFilesResult {
  /** 实际 rename 的文件数（即 plan.from.length） */
  moved: number;
}

export interface FileMoveDeps {
  db: Database.Database;
}

/** rename 已全部成功但事务失败：文件已挪、配置未改，需人工核对（不做自动回滚补偿） */
export class FileMoveError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FileMoveError";
  }
}

export function moveFiles(deps: FileMoveDeps, plan: MoveFilesPlan): MoveFilesResult {
  if (plan.from.length !== plan.to.length) {
    throw new Error(
      `fileMove: from/to 长度不一致（from=${plan.from.length}, to=${plan.to.length}）`,
    );
  }

  for (let i = 0; i < plan.from.length; i++) {
    renameSync(plan.from[i], plan.to[i]);
  }

  const repo = createModelRepo(deps.db);
  try {
    deps.db.transaction(() => {
      // 迁移集合去重：多个模型字段可能共享同一条旧值（同一文件被多个模型
      // 引用），file_meta 只需要迁移一次，用 Map 天然按 from 去重。
      const metaMoves = new Map<string, string>();
      for (const ref of plan.refUpdates) {
        if (ref.field === "gguf_file" || ref.field === "mmproj_file") {
          // 覆盖前先读旧值——这就是"从哪迁到哪"，不需要调用方另算
          const before = repo.getModel(ref.modelName)?.[ref.field];
          if (before !== undefined && before !== ref.nextValue) {
            metaMoves.set(before, ref.nextValue);
          }
        }
        switch (ref.field) {
          case "gguf_file":
            repo.updateModel(ref.modelName, { gguf_file: ref.nextValue });
            break;
          case "mmproj_file":
            repo.updateModel(ref.modelName, { mmproj_file: ref.nextValue });
            break;
          case "namespace":
            repo.updateModel(ref.modelName, { namespace: ref.nextValue });
            break;
        }
      }
      for (const [from, to] of metaMoves) {
        // path 是 UNIQUE 键：目标路径若已有一条孤儿行（比如运维手动 mv 或者上一次
        // 移动遗留的死记录），说明它已经跟丢了真实文件——新搬来的这份才是真身，
        // 先删掉旧孤儿行腾位置，再把当前行改名过去，而不是保留旧行、放弃迁移。
        deps.db.prepare("DELETE FROM file_meta WHERE path = ?").run(to);
        deps.db
          .prepare("UPDATE file_meta SET path = @to, updated_at = @now WHERE path = @from")
          .run({ to, now: Date.now(), from });
      }
    })();
  } catch (error) {
    throw new FileMoveError("文件已移动、配置未更新，请重试或手动核对", { cause: error });
  }

  return { moved: plan.from.length };
}
