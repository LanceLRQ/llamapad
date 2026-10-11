import { NextResponse } from "next/server";
import { z } from "zod";

import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { getUpstreamMonitor } from "@/server/locators";
import {
  UpstreamError,
  deleteUpstream,
  getDefaultUpstream,
  getUpstream,
  updateUpstream,
  upstreamErrorStatus,
} from "@/server/repo/upstreams";
import { toUpstreamView } from "@/server/upstreams/view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * - GET    /api/v1/upstreams/:name → UpstreamView（404 不存在）
 * - PUT    /api/v1/upstreams/:name → UpstreamView。body 的字段都可选，缺席表示不改；
 *   `apiKey` 传空串或 null 表示清除密钥。name 不可改（它是客户端写死的模型名）
 * - DELETE /api/v1/upstreams/:name → 204。删的是默认上游时一并清除默认
 */
const updateBody = z.strictObject({
  displayName: z.string().optional(),
  baseUrl: z.string().optional(),
  apiKey: z.string().nullable().optional(),
  upstreamModel: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
  note: z.string().nullable().optional(),
});

type Ctx = { params: Promise<{ name: string }> };

function errorResponse(error: unknown): Response {
  if (error instanceof UpstreamError) {
    return NextResponse.json(
      { error: error.message, issues: error.field ? [{ path: error.field, message: error.message }] : [] },
      { status: upstreamErrorStatus(error.code) },
    );
  }
  throw error;
}

export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const db = getDb();
  const { name } = await ctx.params;
  const stored = getUpstream(db, name);
  if (stored === null) return NextResponse.json({ error: `上游不存在: ${name}` }, { status: 404 });
  return NextResponse.json(toUpstreamView(stored, getUpstreamMonitor().snapshot(name), getDefaultUpstream(db)));
}

export async function PUT(req: Request, ctx: Ctx): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const parsed = updateBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "invalid_body",
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      },
      { status: 400 },
    );
  }

  const db = getDb();
  const { name } = await ctx.params;
  try {
    const updated = updateUpstream(db, name, parsed.data);
    const monitor = getUpstreamMonitor();
    // 地址、密钥或启用状态可能变了：重新探测一次，让列表上的状态对应新配置
    monitor.activate(name);
    return NextResponse.json(toUpstreamView(updated, monitor.snapshot(name), getDefaultUpstream(db)));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(req: Request, ctx: Ctx): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const { name } = await ctx.params;
  try {
    deleteUpstream(getDb(), name);
    return new Response(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}
