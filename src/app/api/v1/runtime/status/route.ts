import { NextResponse } from "next/server";
import { probeBusy } from "@/server/drain";
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
 *
 * 查询参数 `?busy=1`（供 llamapad-dsh-plugin 等调用方按需查询忙碌状态，见
 * drain.ts）：追加 `busy: { inferring, slotsRunning } | null`——无模型在跑、
 * 模型行已删拿不到 hostPort、或 /slots 探测失败都归为 null（不可知，不是不忙）。
 * 除 "1" 外的取值（含不传、"0"）一律按不启用处理，此时响应体与不带该参数时
 * 逐字节一致（这是前端 start-progress-dialog.tsx 每 2s 轮询的既有硬性约束）。
 */
export async function GET(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const status = await decorateRuntimeStatus(getDb(), getRuntimeService());
  const busyRequested = new URL(req.url).searchParams.get("busy") === "1";
  if (!busyRequested) return NextResponse.json(status);

  // hostPort 直接取 decorateRuntimeStatus 的结果：它与 getRunningContainerInfo
  // 同源同口径（mergeConfig(默认, overrides).docker.host_port，模型行已删为 null），
  // 再查一次等于对 docker 多打一次 list——插件每轮对话都会打这条路径。
  const hostPort = status.running?.hostPort ?? null;
  const busy = hostPort !== null ? await probeBusy(hostPort) : null;
  return NextResponse.json({ ...status, busy });
}
