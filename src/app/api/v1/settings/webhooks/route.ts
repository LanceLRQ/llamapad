import { NextResponse } from "next/server";
import { webhookConfigSchema } from "@/core/webhook";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { recordEvent } from "@/server/events";
import { loadWebhookConfigs, saveWebhookConfigs } from "@/server/webhookDispatcher";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET/PUT /api/v1/settings/webhooks（UX P1 U24）：Webhook 通知渠道整表管理。
 *
 * - GET：返回渠道配置数组（与 webhookDispatcher.ts 的 loadWebhookConfigs 同源，
 *   脏数据容错为空数组，行为与派发器读取完全一致）
 * - PUT body：渠道配置数组（全量替换，非增量 patch——前端每次改动后整表提交，
 *   id 由前端 lib/uuid.randomId 生成）。zod 数组校验失败 400，
 *   校验含 URL 协议收敛（webhookConfigSchema，风险簿⑥ SSRF 面收敛）
 * - 写入成功记一条 kind="settings.webhook" 事件；派发器硬编码排除该 kind，
 *   避免「保存配置」这个动作自己触发一轮出站（防回环，见 webhookDispatcher.ts）
 */

export async function GET(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  return NextResponse.json(loadWebhookConfigs(getDb()));
}

export async function PUT(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const body = await req.json().catch(() => null);
  const result = webhookConfigSchema.array().safeParse(body);
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return NextResponse.json({ error: `渠道配置非法: ${detail}` }, { status: 400 });
  }

  const db = getDb();
  saveWebhookConfigs(db, result.data);
  recordEvent(db, "settings.webhook", `更新 Webhook 渠道配置（共 ${result.data.length} 个）`);

  return NextResponse.json(result.data);
}
