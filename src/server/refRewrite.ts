import type Database from "better-sqlite3";
import { globMatchesPath, hasGlob } from "./fsScanner";
import { createModelRepo } from "./repo/models";

/**
 * 一个文件换了位置之后，把指向它的模型配置改指到新路径（规格 §6.2）。
 *
 * 与 fileMove.ts 的区别：那里是「用户在文件页整组移动」，物理搬运与引用重写
 * 一起做且保持文件名不变；这里是 acquire 的 move-with-refs，物理搬运已经由
 * 队列执行器完成（且**会改名**——档案目录里必须用远端那个文件名），本函数只
 * 负责配置那一半。两者共用同一个 db.transaction() 形态，不共用代码：把 renameSync
 * 和事务拆开会让 fileMove 的「全部 rename 成功后才写库」这条时序保证失效。
 *
 * glob 引用：只拒绝真正可能覆盖 fromRel 的 glob 字段（{@link globMatchesPath}，
 * 从 fsScanner.ts 导出，与 resolveModelFiles 的 glob 匹配同一套字符映射，
 * 不会出现两处判定分家）。物理文件此刻已经搬到新位置，没法像 filesApi.ts 的
 * buildRefMap 那样靠 resolveModelFiles 读盘展开来判定"这个 glob 是否命中
 * fromRel"——旧目录下已经空了，读盘展开只会扑空、放过本该拦住的场景，所以改用
 * 纯字符串匹配。命中的 glob 一律拒绝：`main/m1-*.gguf` 这类分片 glob 改写成
 * 单个新路径会毁掉组内其余分片的解析，这种情况该走档案页的「归位」
 * （planFileMove 本就是整组语义）。不命中的 glob（库里存在但与这次移动的文件
 * 无关的其它分片组）不受影响，不能因为库里存在别的 glob 就把无关的单文件移动
 * 也一并拦下。
 */
export class RefRewriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefRewriteError";
  }
}

/**
 * 把指向 fromRel 的模型配置（gguf_file/mmproj_file）改指到 toRel，file_meta
 * 里同一条记录一并迁移。返回实际改写的模型配置条数（0 表示没有任何引用，
 * 不是错误）。命中 glob 引用时抛 {@link RefRewriteError}，一个配置都不改。
 */
export function rewriteFileRefs(db: Database.Database, fromRel: string, toRel: string): number {
  const repo = createModelRepo(db);
  const targets: { name: string; field: "gguf_file" | "mmproj_file" }[] = [];

  for (const model of repo.listModels()) {
    for (const field of ["gguf_file", "mmproj_file"] as const) {
      const configured = model[field];
      if (configured === undefined) continue;
      if (configured === fromRel) {
        targets.push({ name: model.name, field });
      } else if (hasGlob(configured) && globMatchesPath(configured, fromRel)) {
        throw new RefRewriteError(
          `GLOB_REF: 模型 ${model.name} 的 ${field} 是分片 glob（${configured}），` +
            `不支持单文件改指，请到档案页用「归位」整组移动`,
        );
      }
    }
  }

  if (targets.length === 0) return 0;

  db.transaction(() => {
    for (const t of targets) {
      if (t.field === "gguf_file") repo.updateModel(t.name, { gguf_file: toRel });
      else repo.updateModel(t.name, { mmproj_file: toRel });
    }
    // file_meta 的键是配置字段原始值，配置改了这行也要跟着走，否则备注/哈希缓存
    // 会挂在一个不再存在的路径上（与 fileMove.ts 的 metaMoves 同一考虑）。toRel
    // 若已经有一条孤儿行（比如运维手动 mv 或者上一次迁移遗留的死记录），先删掉
    // 腾位置——path 是 UNIQUE 键，不删的话下面这条 UPDATE 会直接失败
    // （fileMove.ts moveFiles 同一处理，见其内部注释）。
    db.prepare("DELETE FROM file_meta WHERE path = ?").run(toRel);
    db.prepare(
      "UPDATE file_meta SET path = @toRel, probe_path = @toRel, updated_at = @now WHERE path = @fromRel",
    ).run({ toRel, fromRel, now: Date.now() });
  })();

  return targets.length;
}
