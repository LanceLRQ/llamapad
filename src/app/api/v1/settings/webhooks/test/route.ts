import { NextResponse } from "next/server";
import type { WebhookEvent } from "@/core/webhook";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { loadWebhookConfigs, resolveWebhookFetch, sendWebhookRequest } from "@/server/webhookDispatcher";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/settings/webhooks/test（UX P1 U24）：body `{ id }` 立即用一条
 * 假事件对该渠道发起一次真实出站，验证 URL/token 是否配置正确。
 *
 * 不经 matchEvent/enabled 过滤——用户点「测试推送」就是要验证连通性，
 * 与该渠道当前是否启用、订阅哪些 kind 无关。
 *
 * 响应只回 { ok, status }，绝不回显响应体（风险簿⑥：渠道 URL 是管理员自填，
 * 回显响应体等于给了一个通用的服务端出站探测器）。
 */
export async function POST(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const body = (await req.json().catch(() => null)) as { id?: string } | null;
  if (!body || typeof body.id !== "string" || body.id === "") {
    return NextResponse.json({ error: "body 必须是 { id: string }" }, { status: 400 });
  }

  const channel = loadWebhookConfigs(getDb()).find((c) => c.id === body.id);
  if (!channel) {
    return NextResponse.json({ error: "渠道不存在，可能已被删除" }, { status: 404 });
  }

  const fakeEvent: WebhookEvent = {
    id: 0,
    ts: Date.now(),
    kind: "webhook.test",
    message: "这是一条来自 llamapad 的测试推送",
  };

  try {
    const res = await sendWebhookRequest(resolveWebhookFetch(getDb()), channel, fakeEvent);
    return NextResponse.json({ ok: res.ok, status: res.status });
  } catch (error) {
    return NextResponse.json({ ok: false, status: null, error: (error as Error).message });
  }
}
