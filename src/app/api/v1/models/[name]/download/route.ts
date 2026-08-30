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
 * body 可选 `{ files: [{ file, size?, sha256? }], targetDir? }`：
 * - 传 files（T7 向导从量化分组展开）：按文件组入队（分片 + mmproj）
 * - 不传（重试/补下载）：按模型 download 配置的单文件直下
 * - targetDir（阶段 2 B3 新增）：相对 models 根的落盘目录，不传则由 manager
 *   取 model.gguf_file 的目录段作为默认值——不再是 model.namespace（后者是
 *   分组标签，早就可以与文件实际所在目录不一致，用它拼路径会导致重新下载
 *   落错目录，详见 server/download/targetDir.ts 顶部注释）。路径安全校验
 *   （拒绝绝对路径 / .. 段 / 空段）在 manager 内完成，这里只做类型收窄。
 *
 * 状态码：
 * - 202：入队成功，返回 `{ taskIds }`（队列已 kick）
 * - 400：body 校验失败（issues[].path 带字段路径）/ targetDir 路径非法
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
  /** UX P1 U15：全部完成后自动启动（届时已有模型在运行则跳过，不自动切换） */
  autoStart: z.boolean().optional(),
  /** 相对 models 根的落盘目录；不传由 manager 取 gguf_file 的目录段兜底，见上方 JSDoc */
  targetDir: z.string().optional(),
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
    const taskIds = await getDownloadManager().enqueueModelDownload(
      model,
      files,
      parsed.data.targetDir,
      { autoStart: parsed.data.autoStart },
    );
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
