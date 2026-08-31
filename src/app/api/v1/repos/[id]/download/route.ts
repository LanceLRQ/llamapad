import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { getDownloadManager } from "@/server/locators";
import { getProfile } from "@/server/repoProfiles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/repos/:id/download：按档案入队下载（薄壳调 manager）。
 *
 * body：`{ files: [{ file: string, size?: number, sha256?: string }] }`
 * （量化分组展开后的文件清单，通常来自本档案 `GET .../files` 返回的
 * `remote.groups`）。`targetDir`/`repo`/`repoId`/`label` 均由档案自身推导，
 * 调用方不必也不能指定 —— 这正是档案模式相对 URL 直链的意义：落盘位置与
 * 来源仓库已经绑死在档案上。
 *
 * 成功 202，响应字段形状：
 * ```
 * { taskIds: number[], batchId: string, skipped: string[] }
 * ```
 * `skipped` 是目标文件已存在且大小匹配而跳过的文件名（mmproj 跨量化共用的
 * 典型场景），全部跳过时 `taskIds` 为空数组。
 *
 * 失败：
 * - 400 `{ error: "id 非法" }` / `{ error: "invalid_body", issues }` /
 *   `{ error: message }`（落盘目录或文件路径非法）
 * - 404 `{ error: "NOT_FOUND" }`（档案不存在）
 * - 409 `{ error: message }`（目标文件已有未完成的下载任务）
 * - 507 `{ error: message }`（磁盘空间不足，组总大小 vs 分区剩余）
 * - 500 `{ error: message }`（其余未归类错误）
 */

/** 与 core/schemas.ts 的 sha256Schema 同规则（后者未导出子 schema，此处内联） */
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const downloadBodySchema = z.strictObject({
  files: z
    .array(
      z.strictObject({
        file: z.string().min(1, "file 不能为空"),
        size: z.number().int().positive().optional(),
        sha256: z.string().regex(SHA256_PATTERN, "sha256 必须是 64 位小写 hex").optional(),
      }),
    )
    .min(1, "files 至少一项"),
});

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "id 非法" }, { status: 400 });

  const db = getDb();
  const profile = getProfile(db, id);
  if (profile === null) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  const body = await req.json().catch(() => null);
  const parsed = downloadBodySchema.safeParse(body);
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

  try {
    const result = await getDownloadManager().enqueueDownload({
      files: parsed.data.files,
      targetDir: profile.targetDir,
      source: "hf",
      repo: profile.repo,
      repoId: profile.id,
      label: profile.repo,
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
