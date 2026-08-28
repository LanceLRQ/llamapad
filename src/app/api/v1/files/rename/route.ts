import { join } from "node:path";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { FileMoveError, moveFiles } from "@/server/fileMove";
import { FileMoveGuardError, fileMoveGuardStatus, planFileRename } from "@/server/filesApi";
import { getPanelModelsRoot, getRuntimeService } from "@/server/locators";
import { getModelsHost } from "@/server/panelConfig";
import { maybeAutoSnapshot } from "@/server/snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/files/rename：改名（单文件改整名，分片组只改前缀，设计 §2.3/§2.5）。
 *
 * body：`{ from: string, newName: string }`
 * - 单文件：newName 是完整新文件名（须保留 .gguf 后缀）
 * - 分片组：newName 是新前缀（不含序号段），序号段 `-00001-of-00005.gguf`
 *   系统保留（决策 7），组内全部文件一起改名 + 引用 glob 前缀一并重写
 *
 * 编排与错误响应风格同 POST /api/v1/files/move（见其注释），不再赘述。
 */
const renameBodySchema = z.strictObject({
  from: z.string().min(1, "from 不能为空"),
  newName: z.string().min(1, "newName 不能为空"),
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
  const root = getPanelModelsRoot();

  try {
    const runningModel = (await getRuntimeService().getRuntimeStatus()).running?.model ?? null;
    const plan = planFileRename(db, root, runningModel, parsed.data);

    const hostRoot = getModelsHost();
    try {
      moveFiles(
        { db },
        {
          from: plan.fromRels.map((rel) => join(hostRoot, rel)),
          to: plan.toRels.map((rel) => join(hostRoot, rel)),
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
      "file.rename",
      `重命名文件 ${parsed.data.from} → ${parsed.data.newName}（${plan.fromRels.length} 个文件` +
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
