import { NextResponse } from "next/server";
import { z } from "zod";

import { apiKeyProblem, normalizeUpstreamBaseUrl } from "@/lib/upstream-url";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { getUpstream } from "@/server/repo/upstreams";
import { probeUpstream } from "@/server/upstreams/monitor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/upstreams/test：用请求体里的地址与密钥探测一次，供表单在保存前验证。
 * 不落库、不影响任何上游的存活状态。响应同 /upstreams/:name/test。
 *
 * body `{ baseUrl, apiKey?, name? }`。编辑已有上游时表单拿不到已保存的密钥明文：
 * apiKey 缺席且给了 name，就用该上游已保存的密钥。
 */
const body = z.strictObject({
  baseUrl: z.string().min(1),
  apiKey: z.string().nullable().optional(),
  name: z.string().optional(),
});

export async function POST(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  const url = normalizeUpstreamBaseUrl(parsed.data.baseUrl);
  if (!url.ok) {
    return NextResponse.json(
      { error: "invalid_body", issues: [{ path: "baseUrl", message: "上游地址不合法，只支持 http 或 https" }] },
      { status: 400 },
    );
  }

  const typedKey = parsed.data.apiKey?.trim() ?? "";
  if (typedKey !== "" && apiKeyProblem(typedKey) !== null) {
    return NextResponse.json(
      {
        error: "invalid_body",
        issues: [{ path: "apiKey", message: "API 密钥只能包含可见的 ASCII 字符，不能有空白或换行" }],
      },
      { status: 400 },
    );
  }
  const savedKey =
    parsed.data.apiKey === undefined && parsed.data.name !== undefined
      ? (getUpstream(getDb(), parsed.data.name)?.apiKey ?? null)
      : null;
  const apiKey = typedKey !== "" ? typedKey : savedKey;

  return NextResponse.json(await probeUpstream({ baseUrl: url.url, apiKey }));
}
