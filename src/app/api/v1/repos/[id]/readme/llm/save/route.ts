import { NextResponse } from "next/server";
import { z } from "zod";

import { extractJson } from "@/lib/llm-json";
import { buildLlmProfiles } from "@/lib/llm-profiles";
import { splitFrontmatter } from "@/lib/readme-frontmatter";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { readReadmeCache, saveLlmCache } from "@/server/hf/readme";
import { getProfile } from "@/server/repoProfiles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  /** 模型输出的原始正文，来自 SSE 的 done 帧 */
  raw: z.string().min(1),
  engine: z.enum(["local", "external"]),
  model: z.string().min(1),
});

/**
 * POST /api/v1/repos/:id/readme/llm/save：用户在对比弹层里点了「覆盖」（批 3）。
 *
 * **收原始文本而不是装配好的 profiles**：落库前服务端重跑一遍解析与回证，
 * 前端篡改 `raw` 也绕不过——伪造的值不可能字面出现在 README 原文里。
 * 落库路径只有这一条和 runExtract 里的首次落库，两条都过回证。
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "id 非法" }, { status: 400 });

  const db = getDb();
  const profile = getProfile(db, id);
  if (profile === null) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  const parsedBody = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsedBody.success) return NextResponse.json({ error: "请求体非法" }, { status: 400 });

  const cached = readReadmeCache(db, profile.repo);
  if (cached === null || cached.content === null || cached.contentSha === null) {
    return NextResponse.json({ error: "NO_README" }, { status: 409 });
  }

  const json = extractJson(parsedBody.data.raw);
  if (json === null) return NextResponse.json({ error: "UNPARSABLE" }, { status: 422 });

  const body = splitFrontmatter(cached.content).body;
  const result = buildLlmProfiles(json, body);

  saveLlmCache(db, profile.repo, {
    profiles: JSON.stringify(result.profiles),
    engine: parsedBody.data.engine,
    model: parsedBody.data.model,
    contentSha: cached.contentSha,
  });

  return NextResponse.json({ ok: true, count: result.profiles.length });
}
