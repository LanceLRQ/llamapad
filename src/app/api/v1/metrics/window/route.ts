import { NextResponse } from "next/server";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { getMetricsCollector, getMetricsStore } from "@/server/locators";
import { buildWindowPayload, parseRangeKey, planWindowQuery, RANGE_DEFS } from "@/server/metrics/window";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/metrics/window?range=30m|2h|24h|7d&since=<ts>：概览图表的窗口
 * 查询（M3 Task 4；增量协议见指标窗口增量协议方案 A）。range 非法 400；
 * from = now - range 交给 store.queryRange 自动降源（ring 5s / 15min 桶）。
 * since 非法（含缺失）不返回 400——它只是一个优化提示，退化成全量即可，
 * 不该让图表报错。
 *
 * 降源判定（是否可以只回增量）完全收敛在 planWindowQuery 这个纯函数里，
 * route 层不做任何判断，只负责组装：这里没有测试基础设施（src/app 下无
 * *.test.ts，本项目既定惯例），三条否决必须在可单测的纯函数里。
 *
 * 响应：`{ range, from, resolution, series, mode }`——series 恒含全部指标
 * 键；full 下空数组=未采集，delta 下空数组=本轮无新点（详见 window.ts）。
 *
 * 首次取用顺带 getMetricsCollector()：采集是惰性单例（locators 首次取用
 * 即开跑 5s 心跳），metrics 的任何消费者出现即视为需要采集，无需额外
 * 启动钩子；后续请求命中单例无额外开销。
 */
export async function GET(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const searchParams = new URL(req.url).searchParams;
  const range = parseRangeKey(searchParams.get("range"));
  if (range === null) {
    return NextResponse.json({ error: "invalid range" }, { status: 400 });
  }

  getMetricsCollector(); // 确保采集心跳已在跑（幂等单例）
  const from = Date.now() - RANGE_DEFS[range]; // 恒为 now - RANGE_DEFS[range]，客户端要拿它裁剪滑窗
  const plan = planWindowQuery(range, searchParams.get("since"), from);
  const queried = getMetricsStore().queryRange(plan.queryFrom);

  // delta 时把每条 series 过滤成 ts > since：这道过滤不是可省的优化，它
  // 同时顺带挡掉了 store.queryRange 在"ring 为空但有 15min 桶"时走 merge
  // 分支返回的桶点（例如没有容器在跑时的 container.*）——桶点的 ts 是 15
  // 分钟边界，恒 ≤ since，delta 里因此不会混进 15min 桶点。
  const since = plan.since;
  const filtered =
    plan.mode === "delta" && since !== null
      ? Object.fromEntries(
          Object.entries(queried).map(([metric, points]) => [metric, points.filter((p) => p.ts > since)]),
        )
      : queried;

  return NextResponse.json(buildWindowPayload(range, from, filtered, plan.mode));
}
