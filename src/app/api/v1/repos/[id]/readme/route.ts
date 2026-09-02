import { NextResponse } from "next/server";

import { frontmatterBadges, splitFrontmatter } from "@/lib/readme-frontmatter";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { resolveHfOptions } from "@/server/hf/client";
import { getReadme } from "@/server/hf/readme";
import { getProfile } from "@/server/repoProfiles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/repos/:id/readme：档案的 HF 模型卡。
 *
 * 挂在 repos/:id 而不是 hf/repos/:repo —— 详情页手上就是 id，鉴权与档案存在性
 * 判定现成；服务端由 id 查出 repo 再查缓存。
 *
 * `?refresh=1` 绕过缓存强制重取（「刷新」按钮）。
 *
 * 成功 200：
 * ```
 * {
 *   repo: string
 *   content: string | null   // 剥掉 frontmatter 的正文；null = 该仓库没有 README
 *   badges: Array<{ key: string; value: string }>
 *   endpoint: string         // 前端改写相对链接要用（官方或镜像）
 *   truncated: boolean
 *   fetchedAt: number        // 0 = 从没成功拉过
 *   profiles: unknown[]      // P3 才有内容，此前恒为空数组
 *   profilesEngine: string | null
 *   error: { kind: "notFound" | "unauthorized" | "network"; message: string } | null
 * }
 * ```
 *
 * **error 非空时其余字段仍可能有值**（有旧缓存、这次刷新失败）：前端展示旧内容 +
 * 失败提示，不白屏。与档案详情页既有的降级原则一致。
 *
 * 失败：400 `{ error: "id 非法" }`；404 `{ error: "NOT_FOUND" }`（**档案**不存在，
 * 与「仓库没有 README」不是一回事，后者是 200 + `error.kind = "notFound"`）。
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "id 非法" }, { status: 400 });

  const db = getDb();
  const profile = getProfile(db, id);
  if (profile === null) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  const refresh = new URL(req.url).searchParams.get("refresh") === "1";
  const hf = await resolveHfOptions();
  const result = await getReadme(db, profile.repo, { hf, refresh });

  const { meta, body } = result.content === null
    ? { meta: null, body: null }
    : splitFrontmatter(result.content);

  return NextResponse.json({
    repo: profile.repo,
    content: body,
    badges: frontmatterBadges(meta),
    endpoint: hf.endpoint ?? "https://huggingface.co",
    truncated: result.truncated,
    fetchedAt: result.fetchedAt,
    profiles: result.profiles === null ? [] : (JSON.parse(result.profiles) as unknown[]),
    profilesEngine: result.profilesEngine,
    error: result.error,
  });
}
