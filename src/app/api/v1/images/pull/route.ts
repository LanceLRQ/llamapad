import { NextResponse } from "next/server";
import { z } from "zod";
import { createPullProgress } from "@/core/pull-progress";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { getSharedDockerAdapter } from "@/server/locators";
import { createModelRepo } from "@/server/repo/models";
import { sseResponse } from "@/server/sse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/images/pull（U14）：拉取运行镜像最新版，进度经 SSE 推给前端。
 *
 * body `{ image? }`：省略时取当前 `default_config.docker.image`（Settings
 * 卡片的默认按钮场景）；传入时校验非空、长度 ≤ 200（给未来"临时改镜像测试拉取"
 * 留口子，见计划 Mac 实测步骤）。
 *
 * 事件形态（data 均为单行 JSON）：
 * - { "type": "progress", percent, status, layers, completedLayers }：
 *   逐帧聚合进度（core/pull-progress，聚合语义见其文件头）
 * - { "type": "done" }：拉取成功
 * - { "type": "error", message }：拉取失败（镜像不存在/网络等），发送后关闭连接
 *   （不走 SSE 层面的 error，避免客户端把这当成连接异常而非业务失败）
 *
 * 中止（§5.5）：req.signal 直接透传给 adapter.pullImage，前端断开 SSE 连接
 * 即触发中止——销毁 dockerode 侧的 pull 读流。如实告知边界：Docker Engine API
 * 没有"取消 pull"端点，daemon 端是否真正停止下载不保证，本机制只保证面板
 * 这端立刻停止等待/不再消耗这条连接。客户端断开后 session.send 已因
 * sseResponse 的 cancel 钩子变为静默 no-op，故此处无需额外判断 aborted。
 */

const bodySchema = z.strictObject({
  image: z
    .string()
    .trim()
    .min(1, "image 不能为空")
    .max(200, "image 长度不能超过 200")
    .optional(),
});

export async function POST(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

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

  const image = parsed.data.image ?? createModelRepo(getDb()).getDefaultConfig().docker.image;
  const adapter = getSharedDockerAdapter();

  return sseResponse(async (session, controller) => {
    const progress = createPullProgress();
    try {
      await adapter.pullImage(
        image,
        (frame) => {
          progress.feed(frame);
          session.send({ type: "progress", ...progress.snapshot() });
        },
        req.signal,
      );
      session.send({ type: "done" });
    } catch (error) {
      session.send({ type: "error", message: (error as Error).message });
    } finally {
      controller.close();
    }
  });
}
