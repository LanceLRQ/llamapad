import { NextResponse } from "next/server";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { resolveHfOptions } from "@/server/hf/client";
import { testHfConnection } from "@/server/hf/verify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/settings/hf/test（M2 Task 9）：用**当前生效配置**（resolveHfOptions：
 * env HF_TOKEN > hf_token 表；settings.hf_mirror；panel.yaml proxy）调 hub 的
 * whoAmI 做连通性/令牌验证。
 *
 * - 成功 → 200 `{ ok: true, account, mirrorUsed, viaProxy }`：
 *   account = 账号名，或字面量 "anonymous"（匿名时 whoAmI 必 401，但拿到 HTTP
 *   响应即证明端点可达——见 verify.ts 的语义说明）；mirrorUsed 为 official 或
 *   镜像 URL；viaProxy 仅表示 panel.yaml 配置了 proxy（请求经其转发）
 * - 失败 → 502 `{ ok: false, error }`：error 为 verify.ts mapWhoAmIError 产出的
 *   中文 message（401/403→Token 无效；429→限流；网络错误含原始 message），
 *   客户端按 message 行内展示（与 hf/repos/:id/files 的 502 约定一致）
 */
export async function POST(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const opts = await resolveHfOptions();
  try {
    const result = await testHfConnection(opts);
    return NextResponse.json({
      ok: true,
      account: result.account,
      mirrorUsed: opts.endpoint ?? "official",
      viaProxy: opts.proxy !== undefined,
    });
  } catch (error) {
    return NextResponse.json({ ok: false, error: (error as Error).message }, { status: 502 });
  }
}
