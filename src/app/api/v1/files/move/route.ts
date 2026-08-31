import { join } from "node:path";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { FileMoveError, moveFiles } from "@/server/fileMove";
import { FileMoveGuardError, fileMoveGuardStatus, planFileMove } from "@/server/filesApi";
import { getPanelModelsRoot, getRuntimeService } from "@/server/locators";
import { maybeAutoSnapshot } from "@/server/snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/files/move：移动文件（分片组整组移动，设计 §2.3/§2.5）。
 *
 * body：`{ from: string, toFolder: string }`（from 相对 panel models 根，
 * toFolder 须是磁盘上已存在的目录——A6 改定：曾经要求 toFolder 命中
 * models.namespace 配置表，但磁盘目录与命名空间表早已脱钩，真机 6 个目录
 * 只登记了 1 个，会把用户在磁盘上真实建的目录当非法目标拒掉）。
 *
 * 编排（route 只做薄壳）：planFileMove（filesApi，算好相对路径计划 + 引用
 * 重写，守卫顺序 INVALID_PATH → LOCKED → NOT_FOUND → CONFLICT）→
 * fileMove.moveFiles（T1 原语，面板视角物理 rename + 单事务批量重写引用）→
 * 自动快照 + events。目标目录不存在时 planFileMove 直接拒绝（INVALID_PATH），
 * 本 route 不再惰性创建它——本阶段的语义就是"只能移到既有目录"，惰性创建会
 * 让手滑打错的路径也能通过，静默建出一堆空目录。
 *
 * 决策 9：移动总是同步全部引用，不提供"仅挪文件"的旁路，故不设 force 参数，
 * 引用本身不构成阻塞——只有 LOCKED（运行中模型引用）无条件拒绝。
 *
 * 错误响应：`{ error: "LOCKED"|"INVALID_PATH"|"CONFLICT"|"NOT_FOUND", message }`
 * （与既有 DELETE /api/v1/files 的 `{ error: 消息文本 }` 形态不同——错误码风格
 * 是本模块设计明确要的契约，见设计 §2.5）。
 */
const moveBodySchema = z.strictObject({
  from: z.string().min(1, "from 不能为空"),
  toFolder: z.string().min(1, "toFolder 不能为空"),
});

export async function POST(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const body = await req.json().catch(() => null);
  const parsed = moveBodySchema.safeParse(body);
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
  const root = getPanelModelsRoot();

  try {
    const runningModel = (await getRuntimeService().getRuntimeStatus()).running?.model ?? null;
    const plan = planFileMove(db, root, runningModel, parsed.data);

    try {
      moveFiles(
        { db },
        {
          from: plan.fromRels.map((rel) => join(root, rel)),
          to: plan.toRels.map((rel) => join(root, rel)),
          refUpdates: plan.refUpdates,
        },
      );
    } catch (error) {
      if (error instanceof FileMoveError) {
        return NextResponse.json({ error: "MOVE_PARTIAL", message: error.message }, { status: 500 });
      }
      throw error;
    }

    maybeAutoSnapshot(db); // 配置变更点：自动快照（同步写盘毫秒级；失败仅 warn）
    const affectedModels = new Set(plan.refChanges.map((c) => c.modelName)).size;
    db.prepare("INSERT INTO events(ts, kind, message) VALUES (?, ?, ?)").run(
      Date.now(),
      "file.move",
      `移动文件 ${parsed.data.from} → ${parsed.data.toFolder}（${plan.fromRels.length} 个文件` +
        (affectedModels > 0 ? `，同步更新 ${affectedModels} 个引用模型` : "") +
        "）",
    );

    return NextResponse.json({ moved: plan.toRels, refUpdates: plan.refChanges });
  } catch (error) {
    if (error instanceof FileMoveGuardError) {
      return NextResponse.json(
        { error: error.code, message: error.message },
        { status: fileMoveGuardStatus(error.code) },
      );
    }
    throw error;
  }
}
