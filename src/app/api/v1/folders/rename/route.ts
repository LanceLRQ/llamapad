import { NextResponse } from "next/server";
import { z } from "zod";
import { findBlockingRepoDir } from "@/lib/repo-path";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { FileMoveError } from "@/server/fileMove";
import { FolderError, folderErrorStatus, renameFolder } from "@/server/folders";
import { getPanelModelsRoot, getRuntimeService } from "@/server/locators";
import { listRepoDirs } from "@/server/repoDirs";
import { maybeAutoSnapshot } from "@/server/snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/folders/rename（阶段 1b B2）：重命名 models 根下的一个一级
 * 文件夹。与命名空间彻底切割（B1）：本接口只重命名磁盘目录 + 重写指向该
 * 目录的 gguf_file / mmproj_file 路径段，绝不碰 models.namespace——重命名
 * 命名空间请走 PATCH /api/v1/namespaces/:name（纯 DB 操作）。
 *
 * body：`{ from: string, to: string }`（均为一级目录名，不含 "/"；多级目录
 * 是后续阶段的事）。
 *
 * 错误响应 `{ error: CODE, message }`（与 files/move 同款契约），
 * INVALID_NAME/CONFLICT→400、NOT_FOUND→404、LOCKED→423；
 * INVALID_PATH→400（批 3 第 1 项：from 命中档案目录，见下方守卫）。
 *
 * 档案目录守卫（批 3 第 1 项）：`from` 若是某份档案的目录、落在某份档案目录
 * 内部、或是某份档案目录的祖先，一律拒绝——档案目录只能整组随档案走
 * `repoProfiles.moveProfile`（换存放位置）。守卫必须放在这个 route 层，不能
 * 放进 `folders.renameFolder` 服务函数：`moveProfile` 正是靠调用
 * `renameFolder` 来搬档案目录的，把守卫加进服务函数会直接打死这条已上线的
 * 功能。route 层同样是服务端，满足"规则必须在服务端立住、不能只靠 UI 禁用
 * 按钮"这条要求（见 filesApi.ts 头注释同款立场）。
 */
const renameBodySchema = z.strictObject({
  from: z.string().min(1, "from 不能为空"),
  to: z.string().min(1, "to 不能为空"),
});

export async function POST(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const body = await req.json().catch(() => null);
  const parsed = renameBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "invalid_body",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
      { status: 400 },
    );
  }

  const db = getDb();

  // 档案目录守卫（批 3 第 1 项）：放在 renameFolder 调用之前、route 层这一次
  // 调用即挡住——判定本身是纯函数 findBlockingRepoDir，服务函数 renameFolder
  // 不能背这道守卫（见上方头注释）。
  const blockingRepoDir = findBlockingRepoDir(parsed.data.from, listRepoDirs(db));
  if (blockingRepoDir !== null) {
    return NextResponse.json(
      {
        error: "INVALID_PATH",
        message:
          `INVALID_PATH: ${parsed.data.from} 涉及档案目录 ${blockingRepoDir}，` +
          "档案目录只能整组随档案走「换存放位置」，不能在文件页单独改名",
      },
      { status: 400 },
    );
  }

  try {
    const runningModel = (await getRuntimeService().getRuntimeStatus()).running?.model ?? null;
    const result = renameFolder(
      { db, modelsRoot: getPanelModelsRoot(), runningModel },
      parsed.data,
    );

    maybeAutoSnapshot(db); // 配置变更点：自动快照（同步写盘毫秒级；失败仅 warn）
    const affectedModels = new Set(result.refUpdates.map((c) => c.modelName)).size;
    // kind 取 "file." 前缀（不是更直觉的 "folder.rename"）：webhooks-card.tsx
    // 的 KIND_GROUPS 按前缀把事件分组订阅，"file." 已经是「文件操作」这组的
    // 既有前缀（file.move / file.rename 都在其中）——文件夹改名同样是文件页
    // 的一次结构性操作，另起 "folder." 前缀会让只订阅"文件操作"的用户收不到
    // 这条通知，属于隐性遗漏而不是有意的新分类。
    db.prepare("INSERT INTO events(ts, kind, message) VALUES (?, ?, ?)").run(
      Date.now(),
      "file.folder_rename",
      `重命名文件夹 ${parsed.data.from} → ${parsed.data.to}（${result.renamed} 个文件` +
        (affectedModels > 0 ? `，同步更新 ${affectedModels} 个引用模型` : "") +
        "）",
    );

    return NextResponse.json({ renamed: result.renamed, refUpdates: result.refUpdates });
  } catch (error) {
    if (error instanceof FolderError) {
      return NextResponse.json(
        { error: error.code, message: error.message },
        { status: folderErrorStatus(error.code) },
      );
    }
    // 目录已 renameSync 成功、引用重写事务却失败：文件在新位置、配置还指着
    // 旧目录段，与 POST /api/v1/files/move 的 MOVE_PARTIAL 同一形态，错误码
    // 保持一致（fileMove 原语按既有取舍不做回滚补偿，见其头注释）。这里比
    // 单文件移动更要紧——失手波及的是整个目录下所有模型的配置，必须让用户
    // 看到"文件已移动、配置未更新"这句话，而不是一个没有下文的 500
    if (error instanceof FileMoveError) {
      return NextResponse.json({ error: "MOVE_PARTIAL", message: error.message }, { status: 500 });
    }
    throw error;
  }
}
