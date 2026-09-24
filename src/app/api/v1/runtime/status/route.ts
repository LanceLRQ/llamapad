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
 * 响应：`{ running, models, defaultModel, starting }`
 * - models：全部运行中的模型，按启动时间升序；每项
 *   `{ model, displayName, container, startedAt, hostPort, configuredHostPort, configStale, ready }`
 * - running：默认模型那一项（无模型运行时为 null）。保留它是为了兼容单模型时代的
 *   调用方：面板自己的 Chat 加载态、设置页镜像卡，以及 llamapad-dsh-plugin
 * - defaultModel：API 中转不带 model 时发往的模型名
 * - hostPort 是实际发布的端口（冲突时会被顺延），configuredHostPort 是配置值
 * - starting：正在启动/重启中的模型列表，每项 `{ model, displayName, action, since, stage }`，
 *   按 since 升序。start/restart 请求发出到返回之前（含首次拉取镜像那几分钟）容器
 *   要么还不存在要么还没进入运行状态，`models`/`running` 看不到它，靠这个字段才能
 *   知道面板正在忙哪个模型。`stage` 依次是 preparing（校验/清场）→ pulling（拉镜像，
 *   本地已有镜像会跳过）→ creating（容器已建好，即将启动）。start 请求一旦返回，
 *   对应模型就从这里移除、转入 models；这之后是否真的可用仍要看 ready，容器在跑
 *   不代表权重已经加载完。容器刚建好、面板还在做启动即退检测的那几秒内，同一个
 *   模型可能同时出现在 models 和 starting 两处，这是正常现象，二者语义不同（一个
 *   是"有容器"，一个是"启动请求还没返回"）。多模型并行下可能同时有多个 starting 条目
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
