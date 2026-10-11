import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { chooseDefaultModel } from "@/server/defaultModelChoice";
import { getRuntimeService, getUpstreamMonitor } from "@/server/locators";
import { effectiveDefault, loadRelayContext } from "@/server/relayRouting";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 默认模型（多模型并行，决策 D5）：API 中转请求不带 model 字段（或带了面板不认识的名字）时发往它。
 *
 * 两个来源：
 * - 托管模型的默认是进程内状态，不落库；面板重启后按最早启动的在跑模型重建
 * - 外部上游被设为默认时落库（settings.default_upstream），显式选择优先：只要它启用，
 *   托管模型启动不会抢走默认。它不可达且有托管模型在跑时，临时降级到托管默认
 *
 * - GET → `{ defaultModel, kind, degraded, models }`。defaultModel 是生效的默认；
 *   kind 为 "managed" | "external" | null；degraded 表示默认上游不可达、流量已临时改发；
 *   models 为运行中的托管模型名（按启动时间升序）
 * - PUT `{ model }` → 200 `{ defaultModel }`。model 是启用的外部上游 → 落库；
 *   是运行中的托管模型 → 清除落库的默认上游并设为托管默认；
 *   是已停用的上游或没在运行的模型 → 409；请求体不合法 → 400
 */

const bodySchema = z.strictObject({ model: z.string().min(1) });

export async function GET(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const relay = await loadRelayContext(getDb(), getRuntimeService(), getUpstreamMonitor());
  const current = effectiveDefault(relay);
  return NextResponse.json({
    defaultModel: current.name,
    kind: current.kind,
    degraded: current.degraded,
    models: relay.status.models.map((m) => m.model),
  });
}

export async function PUT(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
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
  const { model } = parsed.data;

  const choice = await chooseDefaultModel(db, getRuntimeService(), model);
  if (choice.kind === "upstream-disabled") {
    return NextResponse.json({ error: `外部上游 ${model} 已停用，不能设为默认模型` }, { status: 409 });
  }
  if (choice.kind === "not-running") {
    return NextResponse.json({ error: choice.message }, { status: 409 });
  }
  return NextResponse.json({ defaultModel: model });
}
