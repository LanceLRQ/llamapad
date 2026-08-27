import { NextResponse } from "next/server";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { getHostNetSettingsSnapshot } from "@/server/metrics/hostNetSettings";
import { saveHostNetIfacePreference } from "@/server/metrics/hostNet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET/PUT /api/v1/settings/host-net（追加需求 2026-08-27：网络指标允许用户
 * 选择监控哪一块网卡，默认自动选）。静态段 host-net 优先于同级的 [key]
 * 动态路由，与 hf/webhooks 同款共存方式（见 settings/hf/route.ts 头注释）。
 *
 * - GET：`{ preference, resolvedIface, availableIfaces }`——快照组装在
 *   server/metrics/hostNetSettings.ts（设置页 SSR 共用同一份逻辑）
 * - PUT body `{ iface: string }`：iface 必须是 "auto" 或当前探测到的物理
 *   网卡之一，否则 400（防止把明显打字错误的网卡名存进库——运行时的"配置的
 *   网卡消失→回落 auto"兜底针对的是部署后网卡改名/拔出这类事后变化，
 *   不代替此处的输入校验）
 */
export async function GET(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  return NextResponse.json(await getHostNetSettingsSnapshot(getDb()));
}

export async function PUT(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const body = (await req.json().catch(() => null)) as { iface?: unknown } | null;
  if (body === null || typeof body.iface !== "string" || body.iface.trim() === "") {
    return NextResponse.json({ error: "body 必须是 { iface: string }" }, { status: 400 });
  }
  const iface = body.iface.trim();

  if (iface !== "auto") {
    const snapshot = await getHostNetSettingsSnapshot(getDb());
    if (!snapshot.availableIfaces.includes(iface)) {
      return NextResponse.json(
        { error: `iface 非法: ${iface}（应为 "auto" 或当前探测到的物理网卡之一）` },
        { status: 400 },
      );
    }
  }

  saveHostNetIfacePreference(getDb(), iface);
  return NextResponse.json(await getHostNetSettingsSnapshot(getDb()));
}
