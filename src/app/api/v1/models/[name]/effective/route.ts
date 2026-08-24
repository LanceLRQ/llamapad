import { NextResponse } from "next/server";
import { effectiveParams, mergeConfig } from "@/core/config";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { createModelRepo } from "@/server/repo/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/models/:name/effective（M1 Task 8）：生效参数预览的数据源。
 *
 * 响应：`{ defaults, merged, params, overriddenKeys }`
 * - defaults：settings.default_config（未设置时为内置默认）
 * - merged：mergeConfig(defaults, model.overrides)
 * - params：effectiveParams(...) 拍平的 "docker.xxx"/"server.xxx" 22 键
 * - overriddenKeys：模型 overrides 两 section 展开的键（"server.temp" 形式）
 *
 * 服务端算一份供脚本 / 初始渲染调用；模型编辑页在客户端用同一组纯函数
 * 实时重算（@/core/config 可进客户端包），本路由主要服务外部联调与自检。
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ name: string }> },
): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const { name } = await ctx.params;
  const repo = createModelRepo(getDb());
  const model = repo.getModel(name);
  if (!model) {
    return NextResponse.json({ error: `模型不存在: ${name}` }, { status: 404 });
  }

  const defaults = repo.getDefaultConfig();
  const overrides = model.overrides ?? {};
  const overriddenKeys = [
    ...Object.keys(overrides.docker ?? {}).map((key) => `docker.${key}`),
    ...Object.keys(overrides.server ?? {}).map((key) => `server.${key}`),
  ];

  try {
    const merged = mergeConfig(defaults, overrides);
    const params = effectiveParams(defaults, overrides);
    return NextResponse.json({ defaults, merged, params, overriddenKeys });
  } catch (error) {
    // 库内 overrides 损坏（绕过 schema 写入）：如实报 500，不静默降级
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
