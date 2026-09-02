import { NextResponse } from "next/server";
import { z } from "zod";

import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { PresetError, createPreset, listPresets, presetErrorStatus } from "@/server/repo/presets";
import { maybeAutoSnapshot } from "@/server/snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET  /api/v1/presets：全部参数预设，按名称排序。
 * POST /api/v1/presets：新建。body `{ name, description?, server, source?, sourceRepo? }`
 *
 * 内置三档不经过这条路由——它们在 lib/param-presets.ts 里，前端自己拼在列表前面。
 *
 * 失败：400 INVALID_NAME / 409 CONFLICT（重名）。
 */
const createBody = z.object({
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  server: z.record(z.string(), z.unknown()),
  source: z.enum(["manual", "readme", "model"]).optional(),
  sourceRepo: z.string().nullable().optional(),
});

export async function GET(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;
  return NextResponse.json({ presets: listPresets(getDb()) });
}

export async function POST(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const parsed = createBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return NextResponse.json({ error: `请求体校验失败: ${detail}` }, { status: 400 });
  }

  const db = getDb();
  try {
    const preset = createPreset(db, {
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      server: parsed.data.server,
      source: parsed.data.source,
      sourceRepo: parsed.data.sourceRepo ?? null,
    });
    // 配置变更路由尾部一律调快照（snapshot.ts 头注的既有纪律）
    maybeAutoSnapshot(db);
    return NextResponse.json(preset, { status: 201 });
  } catch (error) {
    if (error instanceof PresetError) {
      return NextResponse.json({ error: error.message }, { status: presetErrorStatus(error.code) });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "创建失败" },
      { status: 400 },
    );
  }
}
