import { NextResponse } from "next/server";
import { z } from "zod";

import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { PresetError, deletePreset, presetErrorStatus, updatePreset } from "@/server/repo/presets";
import { maybeAutoSnapshot } from "@/server/snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PATCH  /api/v1/presets/:id：改名 / 改描述 / 换参数。body 三字段均可选。
 * DELETE /api/v1/presets/:id：删除。
 *
 * 预设不被任何东西引用（应用是快照语义，见 server/repo/presets.ts 头注），
 * 所以删除没有「被引用中」这一档，删了就是删了。
 */
const patchBody = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  server: z.record(z.string(), z.unknown()).optional(),
});

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) ? id : null;
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const id = parseId((await ctx.params).id);
  if (id === null) return NextResponse.json({ error: "id 非法" }, { status: 400 });

  const parsed = patchBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "请求体校验失败" }, { status: 400 });

  const db = getDb();
  try {
    const preset = updatePreset(db, id, parsed.data);
    maybeAutoSnapshot(db);
    return NextResponse.json(preset);
  } catch (error) {
    if (error instanceof PresetError) {
      return NextResponse.json({ error: error.message }, { status: presetErrorStatus(error.code) });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "更新失败" },
      { status: 400 },
    );
  }
}

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const id = parseId((await ctx.params).id);
  if (id === null) return NextResponse.json({ error: "id 非法" }, { status: 400 });

  const db = getDb();
  try {
    deletePreset(db, id);
    maybeAutoSnapshot(db);
    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof PresetError) {
      return NextResponse.json({ error: error.message }, { status: presetErrorStatus(error.code) });
    }
    return NextResponse.json({ error: "删除失败" }, { status: 400 });
  }
}
