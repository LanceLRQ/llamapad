import { NextResponse } from "next/server";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import {
  clearHfToken,
  getHfSettingsSnapshot,
  parseHfMirror,
  parseHfToken,
  saveHfMirror,
  saveHfToken,
} from "@/server/hf/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET/PUT /api/v1/settings/hf（M2 Task 9）：下载源（Hugging Face）统一管理。
 *
 * 静态段 hf 优先于同级的 [key] 动态路由，二者共存：通用键（auto_snapshot/
 * default_config）仍走 [key]，HF 相关键（hf_token 表 + settings.hf_mirror）在此
 * 聚合读写。校验/落库逻辑提纯在 server/hf/settings.ts（设置页 SSR 共用）。
 *
 * - GET：`{ tokenSource, tokenSet, tokenTail, hfMirror, proxy }`——Token 明文
 *   永不回传（只回来源 env|db|null + 尾 4 位）；proxy 来自 panel.yaml 供展示
 * - PUT body `{ token?: string|null, hfMirror?: string }`（至少一项）：
 *   token=null 清空 hf_token 表；非空校验格式（hf_ 前缀或 ≥32 字符）后单行
 *   replace；hfMirror 校验 official | http(s) URL，坏值 400
 * - 写入成功后 events 记 settings.hf（与 config.import 同款事件写入方式）
 */

/** 追加一条事件（与 import 路由的 recordEvent 同款写入方式） */
function recordEvent(kind: string, message: string): void {
  getDb()
    .prepare("INSERT INTO events(ts, kind, message) VALUES (?, ?, ?)")
    .run(Date.now(), kind, message);
}

export async function GET(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  return NextResponse.json(getHfSettingsSnapshot());
}

export async function PUT(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const body = (await req.json().catch(() => null)) as {
    token?: string | null;
    hfMirror?: string;
  } | null;
  if (body === null || (!("token" in body) && !("hfMirror" in body))) {
    return NextResponse.json(
      { error: "body 必须是 { token?, hfMirror? }（至少一项）" },
      { status: 400 },
    );
  }

  // 先整体校验再落库：任一字段非法即 400，不产生半截写入
  let token: string | null | undefined;
  if ("token" in body) {
    if (body.token === null) token = null;
    else if (typeof body.token !== "string") {
      return NextResponse.json({ error: "token 必须是字符串或 null" }, { status: 400 });
    } else if (body.token.trim() === "") {
      return NextResponse.json({ error: "token 不能是空字符串（清空请传 null）" }, { status: 400 });
    } else {
      try {
        token = parseHfToken(body.token.trim());
      } catch (error) {
        return NextResponse.json({ error: (error as Error).message }, { status: 400 });
      }
    }
  }

  let mirror: string | undefined;
  if ("hfMirror" in body) {
    if (typeof body.hfMirror !== "string") {
      return NextResponse.json({ error: "hfMirror 必须是字符串" }, { status: 400 });
    }
    try {
      mirror = parseHfMirror(body.hfMirror.trim());
    } catch (error) {
      return NextResponse.json({ error: (error as Error).message }, { status: 400 });
    }
  }

  const db = getDb();
  if (token !== undefined) {
    if (token === null) clearHfToken(db);
    else saveHfToken(db, token);
  }
  if (mirror !== undefined) saveHfMirror(db, mirror);

  const changes: string[] = [];
  if (token === null) changes.push("清除库内 Token");
  else if (token !== undefined) changes.push(`保存 Token（尾 4 位 ${token.slice(-4)}）`);
  if (mirror !== undefined) changes.push(`镜像=${mirror}`);
  recordEvent("settings.hf", `更新下载源：${changes.join("、")}`);

  // 回读后的新快照（与 GET 同构），前端免二次请求
  return NextResponse.json(getHfSettingsSnapshot());
}
