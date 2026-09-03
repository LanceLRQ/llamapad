import { NextResponse } from "next/server";

import { mergeRequestBody } from "@/lib/llm-extra-body";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { makeProxyFetch } from "@/server/hf/client";
import { classifyBody } from "@/server/llm/engine";
import { resolveLlmConfig } from "@/server/llm/settings";
import { resolveHfOptions } from "@/server/hf/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/settings/llm/test（批 3）：测一次外部 API 连通性。
 *
 * 刻意发一个**最小的非流式**请求（一句 ping、max_tokens 极小），不跑真正的抽取——
 * 测连接不该花掉一次完整抽取的额度。判定同样看响应体不看状态码：实测限流走
 * HTTP 200 + error 体。
 */
export async function POST(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const config = resolveLlmConfig(getDb());
  if (config.baseUrl === null || config.apiKey === null || config.model === null) {
    return NextResponse.json({ ok: false, kind: "notConfigured" }, { status: 200 });
  }

  const proxy = (await resolveHfOptions()).proxy;
  const doFetch = proxy ? makeProxyFetch(proxy) : fetch;

  try {
    const res = await doFetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify(
        mergeRequestBody(config.extraBody, {
          model: config.model,
          messages: [{ role: "user", content: "ping" }],
          stream: false,
          max_tokens: 4,
        }),
      ),
    });

    const text = await res.text();
    const error = classifyBody(res.status, text);
    // classifyBody 对「200 且不是流」也会给 badResponse，但非流式请求本就不该是流，
    // 所以这里只在真有 error 体或状态码异常时才算失败
    if (res.ok && !text.includes('"error"')) {
      return NextResponse.json({ ok: true, model: config.model });
    }
    return NextResponse.json({ ok: false, kind: error?.kind ?? "badResponse", message: error?.message });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      kind: "network",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
