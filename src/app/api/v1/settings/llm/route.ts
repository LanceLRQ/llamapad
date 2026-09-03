import { NextResponse } from "next/server";
import { z } from "zod";

import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { getLlmSettings, saveLlmSettings } from "@/server/llm/settings";
import { getSharedDockerAdapter } from "@/server/locators";
import { getRunningContainerInfo } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const patchSchema = z.object({
  engine: z.enum(["none", "local", "external"]).optional(),
  baseUrl: z.url().nullable().optional(),
  apiKey: z.string().min(1).nullable().optional(),
  model: z.string().min(1).nullable().optional(),
  extraBody: z.string().nullable().optional(),
});

/**
 * GET/PUT /api/v1/settings/llm（批 3）：LLM 解析引擎与外部凭据。
 *
 * - GET 回 `LlmSettingsSnapshot`：**API Key 明文永不回传**，只回
 *   `keySet` / `keyTail`（尾 4 位）/ `keySource`（env|db|null）。
 *   env 来源的字段在 UI 上应表现为只读——那是部署方的决定，面板改不动。
 * - PUT 接受任意子集；某项传 null 表示清除 db 里那份（env 若有仍然生效）。
 *   `extraBody` 只校验「是不是合法 JSON 对象」，不校验语义——它是给 provider
 *   专属字段用的口子，面板不可能知道每家都支持什么。
 */
export async function GET(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const db = getDb();
  // 顺带回「当前是否有模型在运行」：AI 面板要用它判断本地引擎可不可用，
  // 服务端手上就有 getRunningContainerInfo，比让前端再打一次请求划算
  const running = await getRunningContainerInfo(db, getSharedDockerAdapter());
  return NextResponse.json({
    ...getLlmSettings(db),
    hasRunningModel: running !== null && running.hostPort !== null,
  });
}

export async function PUT(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "请求体非法" }, { status: 400 });

  const { extraBody } = parsed.data;
  if (typeof extraBody === "string" && extraBody.trim() !== "") {
    try {
      const value: unknown = JSON.parse(extraBody);
      if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
    } catch {
      return NextResponse.json({ error: "额外请求体必须是一个 JSON 对象" }, { status: 400 });
    }
  }

  saveLlmSettings(getDb(), parsed.data);
  return NextResponse.json(getLlmSettings(getDb()));
}
