import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { getRuntimeService } from "@/server/locators";
import { DEFAULT_DRAIN_TIMEOUT_MS, ReasoningEffortNotAllowedError, RuntimeBusyError } from "@/server/runtime";
import { createModelRepo } from "@/server/repo/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/models/:name/start：启动模型（薄壳调 runtimeService.startModel）。
 *
 * 状态码约定：
 * - 404：模型不存在（启动前用 repo 显式查库判定，不依赖错误 message）
 * - 409：运行时忙（上一个启停请求尚未结束，见 runtime.ts 的 RuntimeBusyError）
 * - 422：配置问题，拒绝启动但不是服务端故障——模型文件缺失（gguf / 已配置的
 *   mmproj 任一缺失），或 reasoning_effort 取值不被该模型 chat template 接受
 *   （ReasoningEffortNotAllowedError，见 runtime.ts；真机复现：容器本会照常
 *   启动、/health 照常 200，只在真正推理时才从 jinja 里炸出一段没法读的 500）
 * - 500：其余失败（docker 适配器异常等）
 *
 * 文件缺失一项依据 startModel 抛错的 message 前缀「模型文件缺失」识别——
 * runtime 层的错误契约是中文 message（见 runtime.ts），此处不修改既有模块；
 * reasoning_effort 一项已有专用错误类型，走 instanceof 判定，不靠字符串匹配。
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
    if (error instanceof RuntimeBusyError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof ReasoningEffortNotAllowedError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("模型文件缺失")) {
      return NextResponse.json({ error: message }, { status: 422 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
