import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { getPanelModelsRoot, getRuntimeService } from "@/server/locators";
import {
  createProfile,
  decorateProfileStats,
  listProfiles,
  RepoProfileError,
  repoProfileErrorStatus,
} from "@/server/repoProfiles";
import { scanTree } from "@/server/fsScanner";
import { maybeAutoSnapshot } from "@/server/snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET  /api/v1/repos：档案列表。**不打 HF** —— 列表页只需要「有哪些档案、各自
 *   本地下了几个文件」，扫盘就够；远端量化清单在点进详情页时才拉（设计 D17）。
 *   响应 `{ repos: RepoProfile[] }`，其中每项在 RepoProfile 基础上额外拼了三个
 *   派生字段：`fileCount`（目录及子目录内文件总数）、`bytes`（文件总字节数）、
 *   `dirExists`（档案目录在磁盘上**是否还存在**——scanTree 对空目录也会返回
 *   一个 files 为空的条目，所以刚建的空档案是 true，只有目录被手动删掉才是
 *   false，档案页据此显示「目录缺失」并给补建入口。它不是「有没有文件」，
 *   那是 fileCount 的事）。
 * POST /api/v1/repos：新建或认领档案，body `{ repo, baseDir }`；响应即
 *   `CreatedProfile`（RepoProfile 基础上多一个 `claimed: boolean`，true 表示
 *   认领了磁盘上已存在的目录，false 表示新建了空目录）。
 */
const createBodySchema = z.strictObject({
  repo: z.string().min(1, "repo 不能为空"),
  baseDir: z.string(),
});

export async function GET(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const db = getDb();
  const root = getPanelModelsRoot();
  const tree = scanTree(root);
  const profiles = decorateProfileStats(listProfiles(db), tree);
  return NextResponse.json({ repos: profiles });
}

export async function POST(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const body = await req.json().catch(() => null);
  const parsed = createBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "invalid_body",
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      },
      { status: 400 },
    );
  }

  const db = getDb();
  try {
    const runningModel = (await getRuntimeService().getRuntimeStatus()).running?.model ?? null;
    const profile = createProfile(
      { db, modelsRoot: getPanelModelsRoot(), runningModel },
      parsed.data,
    );
    maybeAutoSnapshot(db); // 配置变更点：自动快照（同步写盘毫秒级；失败仅 warn）
    db.prepare("INSERT INTO events(ts, kind, message) VALUES (?, ?, ?)").run(
      Date.now(),
      "repo.create",
      `${profile.claimed ? "认领" : "新建"}仓库档案 ${profile.repo} → ${profile.targetDir}`,
    );
    return NextResponse.json(profile, { status: 201 });
  } catch (error) {
    if (error instanceof RepoProfileError) {
      return NextResponse.json(
        { error: error.code, message: error.message },
        { status: repoProfileErrorStatus(error.code) },
      );
    }
    throw error;
  }
}
