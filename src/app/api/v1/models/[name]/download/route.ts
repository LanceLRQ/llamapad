import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { getDownloadManager } from "@/server/locators";
import { createModelRepo } from "@/server/repo/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/models/:name/download（M2 Task 5）：入队下载（薄壳调 manager）。
 *
 * body 可选 `{ files: [{ file, size?, sha256? }] }`：
 * - 传 files（T7 向导从量化分组展开）：按文件组入队（分片 + mmproj）
 * - 不传（重试/补下载）：按模型 download 配置的单文件直下
 *
 * 状态码：
 * - 202：入队成功，返回 `{ taskIds }`（队列已 kick）
 * - 400：body 校验失败（issues[].path 带字段路径）
 * - 404：模型不存在
 * - 409：同一 target_rel 已有未完成任务
 * - 422：模型未配置下载源
 * - 507：磁盘空间不足（组总大小 vs 分区剩余）
 */

/** 与 core/schemas.ts 的 sha256Schema 同规则（后者未导出子 schema，此处内联） */
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const bodySchema = z.strictObject({
  files: z
    .array(
      z.strictObject({
        file: z.string().min(1, "file 不能为空"),
        size: z.number().int().positive().optional(),
        sha256: z.string().regex(SHA256_PATTERN, "sha256 必须是 64 位小写 hex").optional(),
      }),
    )
    .min(1, "files 至少一项")
    .optional(),
});

export async function POST(
  req: Request,
  ctx: { params: Promise<{ name: string }> },
): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const { name } = await ctx.params;
  const model = createModelRepo(getDb()).getModel(name);
  if (!model) {
    return NextResponse.json({ error: `模型不存在: ${name}` }, { status: 404 });
  }
  if (!model.download) {
    return NextResponse.json({ error: `模型未配置下载源: ${name}` }, { status: 422 });
  }

  const body = await req.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(body);
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
  const files =
    parsed.data.files ?? [{ file: model.download.file, sha256: model.download.sha256 }];

  try {
    const taskIds = await getDownloadManager().enqueueModelDownload(model, files);
    return NextResponse.json({ taskIds }, { status: 202 });
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
