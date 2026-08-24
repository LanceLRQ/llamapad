import { NextResponse } from "next/server";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { getRuntimeService } from "@/server/locators";
import { decorateRuntimeStatus } from "@/server/modelsView";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/runtime/status：当前运行模型快照（薄壳调 decorateRuntimeStatus）。
 *
 * 响应：`{ running: { model, displayName, container, startedAt, hostPort } | null, warning? }`
 * - running 为 null 时即 `{ running: null }`
 * - displayName/hostPort 由 repo 模型行 + mergeConfig 补齐；模型行已删时
 *   displayName 退回模型名、hostPort 为 null（见 modelsView.decorateRuntimeStatus）
 * - warning: "multiple" 透传自 runtime 层（违反单模型约束的异常态）
 */
export async function GET(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const status = await decorateRuntimeStatus(getDb(), getRuntimeService());
  return NextResponse.json(status);
}
