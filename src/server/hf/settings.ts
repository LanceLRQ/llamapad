import type Database from "better-sqlite3";
import { z } from "zod";
import { getDb } from "../db";
import { getPanelConfig } from "../panelConfig";

/**
 * HF 下载源设置（M2 Task 9）：设置页区块 + GET/PUT /api/v1/settings/hf 的共享逻辑。
 *
 * 与 client.ts 的 resolveHfOptions 同读三处状态（env HF_TOKEN / hf_token 表 /
 * settings.hf_mirror / 出站代理双源），但视角是「面板可展示/可修改」：
 * - Token 明文永不回传，只回来源（env 只读）+ 尾 4 位
 * - 镜像归一化存储：official | http(s) URL（写入前 parseHfMirror 校验）
 * - 出站代理（真机反馈处置 D4）：settings.outbound_proxy 覆盖 panel.yaml.proxy，
 *   与 Token 同款 env/db 双源模式（这里是 yaml/db）——面板可写，写入即时生效，
 *   panel.yaml 本身不被面板改写（保持文件形态，面板起不来时仍可人工诊断）
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
  /** 生效出站代理（db 覆盖 panel.yaml 后的值）；含用户名密码时已遮蔽，未配置为 null */
  proxy: string | null;
  /** 生效代理的来源：db（面板保存，优先）| yaml（panel.yaml）| null（都未配置） */
  proxySource: "yaml" | "db" | null;
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

/** settings 表存出站代理覆盖值的键（不叫 "proxy"：与 /api/v1/proxy/llama 反代路由的命名语境区分开） */
const PROXY_KEY = "outbound_proxy";

/**
 * 出站代理生效值（D4：db 覆盖 panel.yaml）：settings.outbound_proxy 存在即为生效值，
 * 该行不存在时落回 panel.yaml 的 proxy 字段——与 effectiveToken 的 env/db 顺序同构，
 * 只是这里换成 db/yaml。db 行的存在性本身就是"覆盖开关"：写 saveProxy 即覆盖，
 * clearProxy 删行即让出，不需要额外的"是否启用覆盖"标记位。
 */
function effectiveProxy(db: Database.Database): { source: "yaml" | "db" | null; proxy: string | undefined } {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(PROXY_KEY) as
    | { value: string }
    | undefined;
  if (row) return { source: "db", proxy: row.value };
  const yamlProxy = getPanelConfig().proxy;
  return { source: yamlProxy ? "yaml" : null, proxy: yamlProxy };
}

/**
 * 供三处出站消费点（hf/client.ts、download/manager.ts、webhookDispatcher.ts）调用的
 * 生效代理值——每次调用现读（不缓存），与 getPanelConfig() 原先"随时可能被改配置"的
 * 读取语义一致，改完面板设置无需重启即生效。
 */
export function getEffectiveProxy(db: Database.Database = getDb()): string | undefined {
  return effectiveProxy(db).proxy;
}

/**
 * 遮蔽代理 URL 里的用户名密码（形如 user:pass@host），避免快照被 UI 展示或写进
 * 事件日志时回显明文凭据；不含凭据的 URL 原样返回。仅用于展示层——实际出站请求
 * 仍走 getEffectiveProxy 拿到的完整值，遮蔽不影响真实鉴权。
 * 导出供 PUT /api/v1/settings/hf 路由写事件日志时复用（同一份遮蔽规则，不重复实现）。
 */
export function maskProxyCredentials(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value; // 非法值理论上写入前已被 parseProxy 拦下，这里仅兜底不抛错
  }
  if (!url.username && !url.password) return value;
  url.username = "***";
  url.password = "";
  return url.toString();
}

/** 读出当前下载源快照（GET 路由与设置页 SSR 共用；无副作用） */
export function getHfSettingsSnapshot(db: Database.Database = getDb()): HfSettingsSnapshot {
  const { source, token } = effectiveToken(db);
  const mirror = db.prepare("SELECT value FROM settings WHERE key = 'hf_mirror'").get() as
    | { value: string }
    | undefined;
  const { source: proxySource, proxy } = effectiveProxy(db);
  return {
    tokenSource: source,
    tokenSet: token !== undefined,
    tokenTail: token ? token.slice(-4) : null,
    hfMirror: mirror?.value ?? "official",
    proxy: proxy ? maskProxyCredentials(proxy) : null,
    proxySource,
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

/** 协议前缀 + URL 可解析：ProxyAgent/makeProxyFetch 只认 http(s)/socks5 的 uri 语法 */
const proxySchema = z
  .string()
  .refine((value) => /^(https?|socks5):\/\//i.test(value), {
    message: "需以 http://、https:// 或 socks5:// 开头",
  })
  .refine(
    (value) => {
      try {
        new URL(value);
        return true;
      } catch {
        return false;
      }
    },
    { message: "URL 无法解析（形如 http://host:port 或 socks5://user:pass@host:port）" },
  );

/**
 * 校验写入的代理地址（zod）：协议前缀 + URL 可解析。非法值抛中文 Error（PUT 路由转 400）。
 * 清空走 proxy=null（路由层语义，落回 panel.yaml），不经本函数。
 */
export function parseProxy(value: string): string {
  const parsed = proxySchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`代理地址非法: ${value}（${parsed.error.issues[0]?.message ?? "格式错误"}）`);
  }
  return parsed.data;
}

/** 代理覆盖值落库（upsert settings.outbound_proxy，与 saveHfMirror 同款写法） */
export function saveProxy(db: Database.Database, proxy: string): void {
  db.prepare(
    `INSERT INTO settings(key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(PROXY_KEY, proxy);
}

/** 清除代理覆盖（删行而非写空字符串——生效值随之落回 panel.yaml，不是变成"无代理"） */
export function clearProxy(db: Database.Database): void {
  db.prepare("DELETE FROM settings WHERE key = ?").run(PROXY_KEY);
}
