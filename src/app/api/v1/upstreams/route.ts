import { NextResponse } from "next/server";
import { z } from "zod";

import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { getUpstreamMonitor } from "@/server/locators";
import {
  UpstreamError,
  createUpstream,
  getDefaultUpstream,
  listUpstreams,
  upstreamErrorStatus,
} from "@/server/repo/upstreams";
import { toUpstreamView } from "@/server/upstreams/view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const aliasesBody = z
  .array(z.strictObject({ alias: z.string(), upstreamModel: z.string().nullable().optional() }))
  .max(200);

/**
 * 外部上游：不由面板启停、但可经中转入口访问的 OpenAI 兼容服务。
 *
 * - GET  /api/v1/upstreams → `{ upstreams: UpstreamView[] }`，按 name 排序。密钥只回尾 4 位
 * - POST /api/v1/upstreams → 201 UpstreamView。
 *   body `{ name, displayName, baseUrl, apiKey?, upstreamModel?, enabled?, note?, aliases? }`
 *
 * 失败：400（校验失败，`issues` 指出字段）/ 409（与已有上游、模型配置或别名重名）。
 *
 * 不调自动快照：外部上游不进 YAML 导出（导出文件不含凭据）。
 */
const createBody = z.strictObject({
  name: z.string().min(1),
  displayName: z.string().min(1),
  baseUrl: z.string().min(1),
  apiKey: z.string().nullable().optional(),
  upstreamModel: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
  note: z.string().nullable().optional(),
  aliases: aliasesBody.optional(),
});

export async function GET(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const db = getDb();
  const monitor = getUpstreamMonitor();
  const defaultUpstream = getDefaultUpstream(db);
  return NextResponse.json({
    upstreams: listUpstreams(db).map((stored) => toUpstreamView(stored, monitor.snapshot(stored.name), defaultUpstream)),
  });
}

export async function POST(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const parsed = createBody.safeParse(await req.json().catch(() => null));
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
  try {
    const created = createUpstream(db, parsed.data);
    const monitor = getUpstreamMonitor();
    // 新登记的上游立刻探测一次，不让它在列表里顶着「未知」等到下一个 15 秒
    monitor.activate(created.name);
    return NextResponse.json(toUpstreamView(created, monitor.snapshot(created.name), getDefaultUpstream(db)), {
      status: 201,
    });
  } catch (error) {
    if (error instanceof UpstreamError) {
      return NextResponse.json(
        { error: error.message, issues: error.field ? [{ path: error.field, message: error.message }] : [] },
        { status: upstreamErrorStatus(error.code) },
      );
    }
    throw error;
  }
}
