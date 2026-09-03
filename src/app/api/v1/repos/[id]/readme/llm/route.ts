import { NextResponse } from "next/server";

import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { makeProxyFetch } from "@/server/hf/client";
import { getEffectiveProxy } from "@/server/hf/settings";
import { LlmError, type EngineDelta } from "@/server/llm/engine";
import { runExtract } from "@/server/llm/extract";
import { createExternalEngine } from "@/server/llm/external";
import { createLocalEngine } from "@/server/llm/local";
import { resolveLlmConfig } from "@/server/llm/settings";
import { getSharedDockerAdapter } from "@/server/locators";
import { getProfile } from "@/server/repoProfiles";
import { getRunningContainerInfo } from "@/server/runtime";
import { sseResponse } from "@/server/sse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/repos/:id/readme/llm：用 LLM 再解析一遍 README（批 3）。
 *
 * SSE 响应，帧协议见本任务的计划说明。**只有用户显式点击才会走到这里**——
 * 没有任何自动路径（进页面、切 tab、刷新 README）通向本路由。
 *
 * 结果落库与否由 runExtract 决定：首次直接落，重跑不落、交给 save 路由。
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "id 非法" }, { status: 400 });

  const db = getDb();
  const profile = getProfile(db, id);
  if (profile === null) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  const config = resolveLlmConfig(db);
  const abort = new AbortController();
  // 客户端断开（用户点了取消 / 关了页面）要把上游请求一并掐掉，
  // 否则本地引擎那次推理会继续占着模型槽位跑到底
  req.signal.addEventListener("abort", () => abort.abort());

  return sseResponse(async (session, controller) => {
    try {
      const engine =
        config.engine === "local"
          ? createLocalEngine(
              await getRunningContainerInfo(db, getSharedDockerAdapter()),
              config.extraBody,
              fetch,
            )
          : config.engine === "external"
            ? createExternalEngine(config, proxyFetch(db))
            : (() => {
                throw new LlmError("notConfigured", "AI 解析未启用");
              })();

      let raw = "";
      const outcome = await runExtract({
        db,
        repo: profile.repo,
        engine,
        signal: abort.signal,
        onDelta: (delta: EngineDelta) => {
          if (delta.kind === "content") raw += delta.text;
          session.send({ type: "delta", kind: delta.kind, text: delta.text });
        },
      });

      session.send({ type: "done", ...outcome, raw });
    } catch (error) {
      const kind = error instanceof LlmError ? error.kind : "network";
      const message = error instanceof Error ? error.message : String(error);
      session.send({ type: "error", kind, message });
    } finally {
      controller.close();
    }
  });
}

/** 外部引擎必须走出站代理：实测直连会超时（规格 §13.1） */
function proxyFetch(db: ReturnType<typeof getDb>): typeof fetch {
  const proxy = getEffectiveProxy(db);
  return proxy ? makeProxyFetch(proxy) : fetch;
}
