import { NextResponse } from "next/server";

import { OFFICIAL_HF_ENDPOINT, parseLimit } from "@/lib/hf-models";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { resolveHfOptions } from "@/server/hf/client";
import { getTrendingModels, searchModels } from "@/server/hf/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/hf/models?q=&limit=12&refresh=1（2026-09-21 HF 模型发现设计 §5）：
 * 模型首页发现区的数据源。
 *
 * - `q` 去空白后为空 → 热门榜（进程内缓存 30 分钟）；非空 → 搜索（不缓存）
 * - `limit` 非法值静默回落 12、上限 50（判定在 lib/hf-models.ts 的 parseLimit）
 * - `refresh=1` 绕过缓存强制重取；只对热门榜有意义，搜索本就不缓存
 *
 * 状态码取舍——沿用 hf/repos/[id]/files/route.ts 立下的约定：上游取数失败一律
 * 502 而不透传 HF 的状态码（面板 API 的 404 保留给「面板资源不存在」），具体
 * 原因全在 message 里。**但仅在没有旧缓存可回落时才走 502**：取数失败而缓存里
 * 还有上一批数据时返回 200 + stale:true + error，让前端照常显示旧卡片并提示，
 * 总比把用户正看着的榜单换成一页报错好。
 *
 * 响应里带 `endpoint`（生效站点根）而不是在服务端把外链拼好：拼接规则是纯函数
 * （lib/hf-models.ts 的 hfRepoUrl / hfListUrl）且客户端要按搜索态即时重算
 * 「更多」按钮的目标，给一个根比给一串拼好的 URL 更省也更好测。
 */
export async function GET(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const params = new URL(req.url).searchParams;
  const query = (params.get("q") ?? "").trim();
  const limit = parseLimit(params.get("limit"));
  const refresh = params.get("refresh") === "1";

  const hf = await resolveHfOptions();
  const result =
    query === ""
      ? await getTrendingModels({ hf, limit, refresh })
      : await searchModels(query, { hf, limit });

  // 彻底失败（连旧缓存都没有）才 502；有旧数据则 200 带 stale
  if (result.error !== null && result.items.length === 0) {
    return NextResponse.json({ error: result.error }, { status: 502 });
  }

  return NextResponse.json({
    items: result.items,
    endpoint: hf.endpoint ?? OFFICIAL_HF_ENDPOINT,
    fetchedAt: result.fetchedAt,
    stale: result.stale,
    error: result.error,
  });
}
