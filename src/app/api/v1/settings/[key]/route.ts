import { NextResponse } from "next/server";
import { defaultConfigSchema } from "@/core/schemas";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { AUTO_SNAPSHOT_KEY, maybeAutoSnapshot } from "@/server/snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PUT /api/v1/settings/:key（M2 Task 8）：面板级设置键写入（白名单制）。
 *
 * - key=auto_snapshot：body `{ value: "0" | "1" }`（快照开关，缺省语义见
 *   snapshot.ts；true/false 亦收，归一化存储）——设置页开关的后端
 * - key=default_config：body `{ value: "<DefaultConfig JSON>" }`——默认配置
 *   变更入口（zod 校验失败 400 带字段路径），写入后触发自动快照
 *   （快照钩子清单见 snapshot.ts 头注）
 * - 其他 key：400 拒绝（防任意键写入；新设置键随功能迭代加白名单）
 *
 * 说明：M2 Task 9 将新增 PUT/GET /api/v1/settings/hf 统一管理 HF 相关键；
 * 本路由的 auto_snapshot 语义与其一致，届时由 Task 9 决定收编方式。
 */

/** 各键的 value 校验器：通过返回归一化存储值，否则抛带原因的 Error */
const KEY_WRITERS: Record<string, (value: unknown) => string> = {
  auto_snapshot: (value) => {
    if (value === "1" || value === true) return "1";
    if (value === "0" || value === false) return "0";
    throw new Error("value 必须是 \"0\" 或 \"1\"");
  },
  default_config: (value) => {
    if (typeof value !== "string") throw new Error("value 必须是 DefaultConfig 的 JSON 字符串");
    let raw: unknown;
    try {
      raw = JSON.parse(value);
    } catch (error) {
      throw new Error(`value 不是合法 JSON: ${(error as Error).message}`);
    }
    const parsed = defaultConfigSchema.safeParse(raw);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");
      throw new Error(`default_config 校验失败: ${detail}`);
    }
    return JSON.stringify(parsed.data);
  },
};

export async function PUT(
  req: Request,
  ctx: { params: Promise<{ key: string }> },
): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const { key } = await ctx.params;
  const writer = KEY_WRITERS[key];
  if (writer === undefined) {
    return NextResponse.json(
      { error: `不支持的设置键: ${key}（可写：${Object.keys(KEY_WRITERS).join("、")}）` },
      { status: 400 },
    );
  }

  const body = (await req.json().catch(() => null)) as { value?: unknown } | null;
  if (body === null || !("value" in body)) {
    return NextResponse.json({ error: "body 必须是 { value }" }, { status: 400 });
  }

  let stored: string;
  try {
    stored = writer(body.value);
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }

  getDb()
    .prepare(
      `INSERT INTO settings(key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, stored);

  // default_config 属于配置变更点：写入后同步快照（开关本身不触发）
  if (key === "default_config") maybeAutoSnapshot(getDb());

  return NextResponse.json({ ok: true, key, value: stored });
}

/** GET /api/v1/settings/:key：读回存储值（auto_snapshot 缺省回 "1"） */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ key: string }> },
): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const { key } = await ctx.params;
  const row = getDb()
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  const value = row?.value ?? (key === AUTO_SNAPSHOT_KEY ? "1" : null);
  if (value === null) {
    return NextResponse.json({ error: `未设置的键: ${key}` }, { status: 404 });
  }
  return NextResponse.json({ key, value });
}
