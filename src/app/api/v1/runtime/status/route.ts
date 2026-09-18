import { NextResponse } from "next/server";
import { probeBusy } from "@/server/drain";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { getRuntimeService } from "@/server/locators";
import { decorateRuntimeStatus } from "@/server/modelsView";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/runtime/status：运行状态快照（薄壳调 decorateRuntimeStatus）。
 *
 * 响应：`{ running, models, defaultModel }`
 * - models：全部运行中的模型，按启动时间升序；每项
 *   `{ model, displayName, container, startedAt, hostPort, configuredHostPort, configStale, ready }`
 * - running：默认模型那一项（无模型运行时为 null）。保留它是为了兼容单模型时代的
 *   调用方：面板自己的 Chat 加载态、设置页镜像卡，以及 llamapad-dsh-plugin
 * - defaultModel：API 中转不带 model 时发往的模型名
 * - hostPort 是实际发布的端口（冲突时会被顺延），configuredHostPort 是配置值
 *
 * 查询参数：
 * - `?model=<name>`：running 改为该模型（没在跑则 null）。启动进度框、脚本等某个
 *   模型就绪时用它，不受默认模型是谁影响
 * - `?busy=1`（供 llamapad-dsh-plugin 等按需查询忙碌状态，见 drain.ts）：追加
 *   `busy: { inferring, slotsRunning } | null`，探测对象是 running 那一项。running 为 null、
 *   拿不到端口、或 /slots 探测失败都归为 null（不可知，不是不忙）。除 "1" 外的取值
 *   一律按不启用处理，此时不追加 busy 字段
 */
export async function GET(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const params = new URL(req.url).searchParams;
  const model = params.get("model")?.trim();
  const status = await decorateRuntimeStatus(
    getDb(),
    getRuntimeService(),
    undefined,
    model ? { model } : {},
  );
  if (params.get("busy") !== "1") return NextResponse.json(status);

  // hostPort 直接取 decorateRuntimeStatus 的结果（标签里的实际端口），不必再查一次 docker
  const hostPort = status.running?.hostPort ?? null;
  const busy = hostPort !== null ? await probeBusy(hostPort) : null;
  return NextResponse.json({ ...status, busy });
}
