import { NextResponse } from "next/server";
import { z } from "zod";
import { filenameFromUrl } from "@/lib/download-url";
import { repoDirOf } from "@/lib/repo-path";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { getDownloadManager } from "@/server/locators";
import { listProfiles } from "@/server/repoProfiles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/downloads/direct：URL 直链下载入队，与档案下载解耦的另一条
 * 路径 —— 面对没有仓库结构、没有量化分组的单个文件时（如某人分享的一个
 * .gguf 直链）。
 *
 * body：`{ url: string, targetDir: string, filename?: string }`
 * `filename` 省略时取 URL 路径末段（decode 后）；`targetDir` 相对 models 根。
 *
 * 成功 202，响应字段形状：
 * ```
 * { taskIds: number[], batchId: string, skipped: string[] }
 * ```
 *
 * 失败：
 * - 400 `{ error: "invalid_body", issues }` /
 *   `{ error: "INVALID_PATH", message }`（目标目录落在某个档案目录内）/
 *   `{ error: message }`（落盘目录或文件路径非法）
 * - 409 `{ error: message }`（目标文件已有未完成的下载任务）
 * - 507 `{ error: message }`（磁盘空间不足）
 * - 500 `{ error: message }`（其余未归类错误）
 */
const directBodySchema = z.strictObject({
  url: z.url(),
  targetDir: z.string(),
  filename: z.string().min(1).optional(),
});

export async function POST(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const body = await req.json().catch(() => null);
  const parsed = directBodySchema.safeParse(body);
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
  // URL 直链不得落进任何档案目录：那些目录由档案独占管理，混入自由下载的
  // 文件会让「这个量化下过没有」的判定失真（设计 §9.2，用户原话「不能放到
  // 仓库路径里边，可以自行创建文件夹存放」）
  const repoDirs = listProfiles(db).map((p) => p.targetDir);
  const hit = repoDirOf(parsed.data.targetDir, repoDirs);
  if (hit !== null) {
    return NextResponse.json(
      { error: "INVALID_PATH", message: `不能下载到仓库目录 ${hit}，请另选或新建文件夹` },
      { status: 400 },
    );
  }

  const filename = parsed.data.filename ?? filenameFromUrl(parsed.data.url);

  try {
    const result = await getDownloadManager().enqueueDownload({
      files: [{ file: filename }],
      targetDir: parsed.data.targetDir,
      source: "url",
      url: parsed.data.url,
      label: new URL(parsed.data.url).host,
    });
    return NextResponse.json(result, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("已有未完成的下载任务")) {
      return NextResponse.json({ error: message }, { status: 409 });
    }
    if (message.includes("磁盘空间不足")) {
      return NextResponse.json({ error: message }, { status: 507 });
    }
    if (message.includes("非法")) {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
