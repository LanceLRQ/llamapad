import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { getPanelModelsRoot } from "@/server/locators";
import { getProfile, REPO_MARKER_FILENAME } from "@/server/repoProfiles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/repos/:id/repair：档案目录被手动删掉后的一键补建。
 *
 * 只让磁盘追上 DB，不改任何 DB 行——所以它是幂等的，重复调用无副作用：
 * 目录已存在才跳过 mkdir，标记文件已存在才跳过写入（不覆写，否则会把
 * `createdAt` 刷成现在，丢掉档案真实的创建时间——任务 9 补充裁定 6）。
 * 不复用 POST /api/v1/repos：那条路会因 UNIQUE(base_dir, repo) 撞 CONFLICT，
 * 它的语义是「新建或认领一个还没登记的档案」，而这里档案本来就登记着。
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "id 非法" }, { status: 400 });

  const profile = getProfile(getDb(), id);
  if (profile === null) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  const dir = join(getPanelModelsRoot(), profile.targetDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const marker = join(dir, REPO_MARKER_FILENAME);
  if (!existsSync(marker)) {
    writeFileSync(
      marker,
      `${JSON.stringify({ repo: profile.repo, createdAt: profile.createdAt }, null, 2)}\n`,
    );
  }

  return NextResponse.json({ targetDir: profile.targetDir });
}
