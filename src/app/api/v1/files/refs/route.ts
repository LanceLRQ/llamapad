import { NextResponse } from "next/server";
import { sharedInodePaths } from "@/lib/unclaimed-view";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { FileApiError, getFileRefs, siblingShards } from "@/server/filesApi";
import { scanTree } from "@/server/fsScanner";
import { getPanelModelsRoot, getRuntimeService } from "@/server/locators";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/files/refs?path=<rel>：单文件引用清单（删除确认框数据源）。
 *
 * 响应：`{ refs: [{ modelName, field }], runningLocked, siblings, sharedWith }`
 * - refs：引用该文件的配置（精确相等 + glob 展开命中，见 filesApi.getFileRefs）
 * - runningLocked：refs 中含当前运行模型（此时删除接口连 force 也拒绝）
 * - siblings：同组其余分片（shardGroup 前缀 + total 匹配；非分片为空数组，
 *   供 UI 提示"同组还有 N 个分片"，本接口不自动删组）
 * - sharedWith：与该文件共用同一份数据（同 inode）的其余路径（任务 18，
 *   设计 §9.1）：删除硬链接不释放磁盘空间，UI 据此在删除确认框里提示，
 *   不限于游离文件——已被引用的文件同样可能与某个游离文件共用数据
 *
 * path 缺失 / 非法（含 .. / 绝对路径 / 逃逸 models 根）→ 400。
 */
export async function GET(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const relPath = new URL(req.url).searchParams.get("path");
  if (relPath === null || relPath === "") {
    return NextResponse.json({ error: "缺少 path 查询参数" }, { status: 400 });
  }

  const root = getPanelModelsRoot();
  let refs;
  try {
    refs = getFileRefs(getDb(), root, relPath);
  } catch (error) {
    if (error instanceof FileApiError && error.code === "INVALID_PATH") {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  const runningModel =
    (await getRuntimeService().getRuntimeStatus()).running?.model ?? null;

  return NextResponse.json({
    refs,
    runningLocked: runningModel !== null && refs.some((r) => r.modelName === runningModel),
    siblings: siblingShards(root, relPath),
    sharedWith: sharedInodePaths(scanTree(root), relPath),
  });
}
