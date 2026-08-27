import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { getRuntimeService } from "@/server/locators";
import { DEFAULT_DRAIN_TIMEOUT_MS } from "@/server/runtime";
import { createModelRepo } from "@/server/repo/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/models/:name/start：启动模型（薄壳调 runtimeService.startModel）。
 *
 * 状态码约定：
 * - 404：模型不存在（启动前用 repo 显式查库判定，不依赖错误 message）
 * - 422：模型文件缺失（gguf / 已配置的 mmproj 任一缺失，startModel 拒绝启动）
 * - 500：其余失败（docker 适配器异常等）
 *
 * 422 依据 startModel 抛错的 message 前缀「模型文件缺失」识别——
 * runtime 层的错误契约是中文 message（见 runtime.ts），此处不修改既有模块。
 *
 * body（可选，供 llamapad-dsh-plugin 等调用方按需请求排空，见 runtime.ts /
 * drain.ts）：`{ drain?: boolean, drainTimeoutMs?: number }`。省略 / 空体 /
 * `{}` 均合法（现有面板 UI 与全部既有测试都不发 body）；drain 未请求时响应体
 * 与现在逐字节一致，请求了才追加 `drain: {drained, reason}`。
 */

const bodySchema = z.strictObject({
  drain: z.boolean().optional(),
  drainTimeoutMs: z.number().int().min(1_000).max(600_000).default(DEFAULT_DRAIN_TIMEOUT_MS),
});

export async function POST(
  req: Request,
  ctx: { params: Promise<{ name: string }> },
): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const { name } = await ctx.params;
  if (!createModelRepo(getDb()).getModel(name)) {
    return NextResponse.json({ error: `模型不存在: ${name}` }, { status: 404 });
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

  try {
    const started = await getRuntimeService().startModel(name, parsed.data);
    return NextResponse.json(
      started.drain !== undefined ? { id: started.id, drain: started.drain } : { id: started.id },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("模型文件缺失")) {
      return NextResponse.json({ error: message }, { status: 422 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
