import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { NextResponse } from "next/server";
import { z } from "zod";
import { LLAMA_REGISTRY, recommendServerVariant, SERVER_VARIANTS } from "@/core/images";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { getSharedDockerAdapter } from "@/server/locators";
import { createModelRepo } from "@/server/repo/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const execFile = promisify(execFileCb);

/**
 * GET /api/v1/images、DELETE /api/v1/images（M5 镜像管理 §5.4）
 *
 * GET：本地镜像列表 + 官方 variant 固定清单（core/images.ts §5.2）+ 平台推荐
 * （§5.3）合并展示。状态徽标语义：
 * - "current"：与 default_config.docker.image 字面相等（当前生效）
 * - "local"：本地已拉取但非当前生效
 * - "not_pulled"：本地没有
 *
 * localImages 额外原样返回本地全部镜像（含非官方清单里的自定义镜像），
 * 供设置页"自定义镜像"区块展示用户已拉取过的自备镜像。
 *
 * DELETE：body `{ image }`。当前生效镜像禁止删除（先切换启动镜像再删）；
 * 被运行中容器占用的镜像由 docker 自身拒绝（409），错误原样透出，不转译。
 */

/**
 * 探测 GPU 平台信息喂给 recommendServerVariant（§5.3）：面板容器已因指标
 * 采集注入 --gpus all 并在跑 nvidia-smi，这里复用同一条命令的默认输出
 * （不带 --query-gpu，取头部的 CUDA Version/Driver Version 两行）。
 * 任何失败（无 GPU / 命令不存在 / 超时）都折叠为 null——纯 CPU 部署是
 * 合法形态，不应该让整个 GET 因为探测失败而报错。
 */
async function probeNvidiaSmiHeader(): Promise<string | null> {
  try {
    const { stdout } = await execFile("nvidia-smi", []);
    return stdout;
  } catch {
    return null;
  }
}

/** dockerode 错误的 HTTP 状态码透传（modem 抛的错带 statusCode，如 404/409） */
function dockerErrorStatus(error: unknown): number {
  const code =
    typeof error === "object" && error !== null && "statusCode" in error
      ? (error as { statusCode?: number }).statusCode
      : undefined;
  return typeof code === "number" ? code : 500;
}

export async function GET(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const currentImage = createModelRepo(getDb()).getDefaultConfig().docker.image;
  const adapter = getSharedDockerAdapter();
  const [localImages, header] = await Promise.all([adapter.listImages(), probeNvidiaSmiHeader()]);
  const recommendedTag = recommendServerVariant(header);

  const variants = SERVER_VARIANTS.map(({ tag, platform }) => {
    const ref = `${LLAMA_REGISTRY}:${tag}`;
    const local = localImages.find((image) => image.tags.includes(ref));
    const status = ref === currentImage ? "current" : local ? "local" : "not_pulled";
    return {
      tag,
      platform,
      ref,
      recommended: tag === recommendedTag,
      status,
      local: local ? { id: local.id, size: local.size, created: local.created } : undefined,
    };
  });

  return NextResponse.json({
    registry: LLAMA_REGISTRY,
    currentImage,
    recommendedTag,
    variants,
    localImages,
  });
}

const deleteBodySchema = z.strictObject({
  image: z.string().trim().min(1, "image 不能为空").max(200, "image 长度不能超过 200"),
});

export async function DELETE(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const body = await req.json().catch(() => null);
  const parsed = deleteBodySchema.safeParse(body);
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

  const { image } = parsed.data;
  const currentImage = createModelRepo(getDb()).getDefaultConfig().docker.image;
  if (image === currentImage) {
    return NextResponse.json(
      { error: "current_image", message: "当前生效镜像禁止删除，请先切换启动镜像" },
      { status: 400 },
    );
  }

  try {
    await getSharedDockerAdapter().removeImage(image);
    return NextResponse.json({ ok: true });
  } catch (error) {
    // 被运行中容器占用等 docker 自身守卫，错误原样透出（§5.4），不转译
    return NextResponse.json(
      { error: "docker_error", message: (error as Error).message },
      { status: dockerErrorStatus(error) },
    );
  }
}
