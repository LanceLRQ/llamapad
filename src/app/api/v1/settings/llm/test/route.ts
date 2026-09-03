import { NextResponse } from "next/server";

import { mergeRequestBody } from "@/lib/llm-extra-body";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { makeProxyFetch, resolveHfOptions } from "@/server/hf/client";
import { classifyBody } from "@/server/llm/engine";
import { resolveLlmConfig } from "@/server/llm/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 响应体里是否带着真正的错误对象。
 *
 * 不能用 `text.includes('"error"')` 这种子串匹配：不少网关的统一响应包里带一个
 * 恒为 null 的 `error` 字段（`{"error":null,"choices":[…]}`），那是一次成功的
 * 响应，子串匹配会把它判成失败，再兜底成一句"服务没有返回流式响应"——用户对着
 * 一个本来能用的配置反复折腾。判定口径与 classifyBody 内部保持一致。
 */
function hasErrorPayload(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object") return false;
    const err = (parsed as { error?: unknown }).error;
    return err !== null && err !== undefined && typeof err === "object";
  } catch {
    return false;
  }
}

/**
 * 把错误消息里出现的 API Key 明文替换成 `***`。
 *
 * provider 可能在错误文本里回显我们发过去的 key（比如把整个 Authorization 头
 * 贴进错误详情）。这条路由是唯一一处"带着 key 去发请求、再把 provider 的原话
 * 同步返回给浏览器"的地方，加一道脱敏很便宜。key 为空或过短时不替换——脱敏
 * 没有意义，反而有把消息本身误伤成一堆 *** 的风险。
 */
function maskApiKey(message: string, apiKey: string): string {
  if (apiKey.length < 8) return message;
  return message.split(apiKey).join("***");
}

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
    // classifyBody 对「200 且不是流」也会给 badResponse，但非流式请求本就不该是流，
    // 所以这里只在真有 error 体或状态码异常时才算失败，且只在失败时才调用 classifyBody
    if (res.ok && !hasErrorPayload(text)) {
      return NextResponse.json({ ok: true, model: config.model });
    }
    const error = classifyBody(res.status, text);
    return NextResponse.json({
      ok: false,
      kind: error.kind,
      message: maskApiKey(error.message, config.apiKey),
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      kind: "network",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
