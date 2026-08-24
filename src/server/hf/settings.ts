import type Database from "better-sqlite3";
import { getDb } from "../db";
import { getPanelConfig } from "../panelConfig";

/**
 * HF 下载源设置（M2 Task 9）：设置页区块 + GET/PUT /api/v1/settings/hf 的共享逻辑。
 *
 * 与 client.ts 的 resolveHfOptions 同读三处状态（env HF_TOKEN / hf_token 表 /
 * settings.hf_mirror / panel.yaml proxy），但视角是「面板可展示/可修改」：
 * - Token 明文永不回传，只回来源（env 只读）+ 尾 4 位
 * - 镜像归一化存储：official | http(s) URL（写入前 parseHfMirror 校验）
 * - proxy 来自 panel.yaml，面板内只读展示
 *
 * 提纯为独立模块（而非塞进 route.ts）的原因：Next.js 路由文件只允许
 * handler/段配置导出，且设置页 SSR 需要同一份快照逻辑，双端共用 + 可单测。
 */

/** GET /api/v1/settings/hf 的响应形状（设置页 SSR 初值同构） */
export interface HfSettingsSnapshot {
  /** 生效 Token 的来源：env（只读，优先）| db（面板可写）| null（匿名） */
  tokenSource: "env" | "db" | null;
  /** 是否存在生效 Token（env 或 db） */
  tokenSet: boolean;
  /** 生效 Token 明文后 4 位（不回明文）；未设置时 null */
  tokenTail: string | null;
  /** 镜像：official（官方默认）或 https:// 镜像 URL */
  hfMirror: string;
  /** panel.yaml 的出站代理；未配置为 null */
  proxy: string | null;
}

/** 生效 Token（env 优先，与 resolveHfOptions 同序）；同时返回来源供展示 */
function effectiveToken(db: Database.Database): { source: "env" | "db" | null; token: string | undefined } {
  const envToken = process.env.HF_TOKEN?.trim();
  if (envToken) return { source: "env", token: envToken };
  const row = db.prepare("SELECT token FROM hf_token ORDER BY created_at, rowid LIMIT 1").get() as
    | { token: string }
    | undefined;
  if (row) return { source: "db", token: row.token };
  return { source: null, token: undefined };
}

/** 读出当前下载源快照（GET 路由与设置页 SSR 共用；无副作用） */
export function getHfSettingsSnapshot(db: Database.Database = getDb()): HfSettingsSnapshot {
  const { source, token } = effectiveToken(db);
  const mirror = db.prepare("SELECT value FROM settings WHERE key = 'hf_mirror'").get() as
    | { value: string }
    | undefined;
  return {
    tokenSource: source,
    tokenSet: token !== undefined,
    tokenTail: token ? token.slice(-4) : null,
    hfMirror: mirror?.value ?? "official",
    proxy: getPanelConfig().proxy ?? null,
  };
}

/**
 * 校验并归一化镜像值：`official` 或合法 http(s) URL（尾斜杠差异不影响语义，
 * 保留原样存储）。非法值抛中文 Error（PUT 路由转 400）。
 */
export function parseHfMirror(value: string): string {
  if (value === "official") return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`hfMirror 非法: ${value}（应为 official 或 http(s) URL）`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`hfMirror 协议非法: ${url.protocol}（仅支持 http/https）`);
  }
  return value;
}

/**
 * 校验写入的 Token 格式：hf_ 前缀，或长度 ≥ 32（兼容历史长令牌）。
 * 非法值抛中文 Error。清空走 token=null（路由层语义），不经本函数。
 */
export function parseHfToken(token: string): string {
  if (!token.startsWith("hf_") && token.length < 32) {
    throw new Error("token 格式非法：需 hf_ 前缀或长度不小于 32 的令牌");
  }
  return token;
}

/**
 * Token 落库：单行 replace（删全部旧行 + 插一行），与 resolveHfOptions
 * 「ORDER BY created_at LIMIT 1 取首行」的读取语义配套。
 */
export function saveHfToken(db: Database.Database, token: string): void {
  db.prepare("DELETE FROM hf_token").run();
  db.prepare("INSERT INTO hf_token(token, note, created_at) VALUES (?, NULL, ?)").run(
    token,
    Date.now(),
  );
}

/** 清空库内 Token（hf_token 表整体删除；env 优先级更高，env 在时此操作不改变生效值） */
export function clearHfToken(db: Database.Database): void {
  db.prepare("DELETE FROM hf_token").run();
}

/** 镜像落库（upsert settings.hf_mirror） */
export function saveHfMirror(db: Database.Database, mirror: string): void {
  db.prepare(
    `INSERT INTO settings(key, value) VALUES ('hf_mirror', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(mirror);
}
