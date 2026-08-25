import type Database from "better-sqlite3";
import {
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  createHash,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

/**
 * 鉴权核心（M0 Task 7）
 *
 * 三类凭证：
 * - 管理员密码：scrypt 哈希存 admins 表
 * - 面板 session：HMAC 自包含 token（cookie `llamapad_session`）
 * - API token：`lp_` 前缀明文只出现一次，库存 sha256 哈希（api_tokens 表）
 */

/** scrypt 参数（OWASP 推荐量级：2^14 / 8 / 1，keylen 64 字节）。
 *  序列化格式固定为 `scrypt$saltHex$hashHex`，不含参数字段——调参即换格式（加版本前缀），当前无需。 */
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 } as const;
const SCRYPT_KEYLEN = 64;

// 取舍：用 promisify 的异步 scrypt 而非 scryptSync——KDF 单次耗时几十毫秒，
// route handler 本就是异步上下文，避免阻塞 Node 事件循环（登录/引导期的并发下载不受影响）。
const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: typeof SCRYPT_PARAMS,
) => Promise<Buffer>;

/** settings 表中 session 签名密钥的键 */
const SESSION_SECRET_KEY = "session_secret";

/** session cookie 名 */
export const SESSION_COOKIE = "llamapad_session";

/** session 默认有效期：7 天（秒） */
export const SESSION_TTL_SEC = 7 * 24 * 60 * 60;

// ---------- 密码哈希 ----------

/** 生成 `scrypt$<saltHex>$<hashHex>`；盐为 16 字节随机，每次哈希独立 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

/** 校验密码；stored 格式非法时返回 false（拒绝但不抛非预期异常） */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const [, saltHex, hashHex] = parts;
  // hex 合法性前置检查，避免 Buffer.from 静默吞掉非法字符
  if (!/^[0-9a-f]+$/.test(saltHex) || !/^[0-9a-f]+$/.test(hashHex)) return false;
  try {
    const derived = await scrypt(
      password,
      Buffer.from(saltHex, "hex"),
      Buffer.from(hashHex, "hex").length, // 与存量哈希等长，防长度不匹配抛错
      SCRYPT_PARAMS,
    );
    return derived.length === Buffer.from(hashHex, "hex").length &&
      timingSafeEqual(derived, Buffer.from(hashHex, "hex"));
  } catch {
    return false;
  }
}

// ---------- session ----------

/**
 * 签发自包含 session token：`${exp}.${hmacHex}`。
 *
 * 签名覆盖内容：HMAC-SHA256(secret, String(exp)) —— 即只对"过期时刻的十进制字符串"签名。
 * 说明：单管理员面板，token 不携带身份/角色等声明（唯一主体就是 admin），因此无需签名负载；
 * HMAC 保证 exp 不可篡改（改 exp 必然导致签名失配），过期即失效。
 * 已知边界：token 无服务端状态，吊销只能靠轮换 session_secret（settings 表改值后全部 session 失效）。
 */
export function createSession(secret: string, ttlSec: number): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const hmac = createHmac("sha256", secret).update(String(exp)).digest("hex");
  return `${exp}.${hmac}`;
}

/** 校验 session token；未过期返回 { ok: true, exp }，过期/篡改/格式错返回 null */
export function verifySession(
  token: string,
  secret: string,
): { ok: true; exp: number } | null {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const expStr = token.slice(0, dot);
  const hmacHex = token.slice(dot + 1);
  if (!/^\d+$/.test(expStr) || !/^[0-9a-f]{64}$/.test(hmacHex)) return null;

  const expected = createHmac("sha256", secret).update(expStr).digest("hex");
  if (!timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(hmacHex, "hex"))) return null;

  const exp = Number(expStr);
  // exp <= 当前秒即视为过期（含 ttl=0 签发当刻）
  if (exp <= Math.floor(Date.now() / 1000)) return null;
  return { ok: true, exp };
}

// ---------- API token ----------

/** 生成 `lp_` + 43 位 base64url（= 32 字节熵）明文 token；库中只存 sha256 */
export function generateApiToken(): string {
  return `lp_${randomBytes(32).toString("base64url")}`; // 32B → base64url 恰 43 字符无 padding
}

/** sha256 hex，用于入库比对 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** 签发 API token 并入库（sha256 哈希 + 明文尾 4 位）；返回仅出现一次的明文。
 *  签发/入库原本内联在 POST /auth/tokens，M5 提取到此处供 route 与测试共用。 */
export function issueApiToken(db: Database.Database, name: string | null): string {
  const token = generateApiToken();
  db.prepare(
    "INSERT INTO api_tokens(token_hash, name, created_at, token_tail) VALUES (?, ?, ?, ?)",
  ).run(hashToken(token), name, Date.now(), token.slice(-4));
  return token;
}

/** API token 列表行：明文与完整哈希都不出库，只给可辨识的尾 4 位 */
export interface ApiTokenRow {
  id: number;
  name: string | null;
  createdAt: string;
  /** 明文尾 4 位，供用户对照自己手里的 token */
  tail: string;
}

export function listApiTokens(db: Database.Database): ApiTokenRow[] {
  const rows = db
    .prepare("SELECT id, name, created_at, token_tail FROM api_tokens ORDER BY id DESC")
    .all() as { id: number; name: string | null; created_at: number; token_tail: string | null }[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    createdAt: new Date(r.created_at).toISOString(),
    tail: r.token_tail ?? "",
  }));
}

/** 吊销：删行即失效（requireAuth 每次都查表）。返回是否命中 */
export function revokeApiToken(db: Database.Database, id: number): boolean {
  return db.prepare("DELETE FROM api_tokens WHERE id = ?").run(id).changes > 0;
}

// ---------- requireAuth ----------

export interface RequireAuthOptions {
  /** 是否接受 Authorization: Bearer API token；默认 true。
   *  签发 API token 的路由传 false，避免持有泄漏 token 者自我续命（token 生 token）。 */
  allowBearer?: boolean;
}

export type RequireAuthResult = { ok: true } | Response;

/** 从 Request 的 Cookie 头取指定 cookie（不引入 next/headers，保持可独立单测） */
function getCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return part.slice(eq + 1).trim();
      }
    }
  }
  return null;
}

function unauthorized(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

/**
 * 路由统一鉴权入口：
 * 1) Cookie `llamapad_session` 含合法未过期 session（secret 经 getOrCreateSessionSecret(db) 取/建）→ ok
 * 2) Authorization: Bearer lp_xxx 的 sha256 存在于 api_tokens → ok（allowBearer:false 时跳过）
 * 3) 其余一律 401 JSON { error: "unauthorized" }
 */
export async function requireAuth(
  req: Request,
  db: Database.Database,
  options: RequireAuthOptions = {},
): Promise<RequireAuthResult> {
  const { allowBearer = true } = options;

  const sessionToken = getCookie(req, SESSION_COOKIE);
  if (sessionToken) {
    const secret = getOrCreateSessionSecret(db);
    if (verifySession(sessionToken, secret)) return { ok: true };
  }

  if (allowBearer) {
    const authorization = req.headers.get("authorization");
    const match = authorization ? /^Bearer\s+(\S+)$/i.exec(authorization) : null;
    if (match) {
      const row = db
        .prepare("SELECT id FROM api_tokens WHERE token_hash = ?")
        .get(hashToken(match[1]));
      if (row) return { ok: true };
    }
  }

  return unauthorized();
}

// ---------- bootstrap ----------

/**
 * 取（或建）session 签名密钥：
 * - PANEL_SECRET 环境变量优先（直接返回，不写库——多实例部署时可外部固定）
 * - 否则 settings.session_secret 存在即复用；不存在则生成 32 字节 hex 写入
 * INSERT OR IGNORE + 回读保证并发下的幂等（后到者读到先到者写入的值）。
 */
export function getOrCreateSessionSecret(db: Database.Database): string {
  const fromEnv = process.env.PANEL_SECRET;
  if (fromEnv) return fromEnv;

  const existing = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(SESSION_SECRET_KEY) as { value: string } | undefined;
  if (existing) return existing.value;

  const secret = randomBytes(32).toString("hex");
  db.prepare("INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)").run(
    SESSION_SECRET_KEY,
    secret,
  );
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(SESSION_SECRET_KEY) as { value: string };
  return row.value;
}

/** admins 为空时写入密码哈希（首次 bootstrap）；非空抛错防止重复初始化覆盖既有密码 */
export async function createAdminIfEmpty(db: Database.Database, password: string): Promise<void> {
  const count = db.prepare("SELECT COUNT(*) AS c FROM admins").get() as { c: number };
  if (count.c > 0) {
    throw new Error("管理员已存在，拒绝重复 bootstrap");
  }
  const hash = await hashPassword(password);
  db.prepare("INSERT INTO admins(password_hash, created_at) VALUES (?, ?)").run(hash, Date.now());
}

/**
 * 环境变量 bootstrap：PANEL_ADMIN_PASSWORD 已设且 admins 为空时创建管理员。
 * 与 POST /auth/setup 构成"二选一"的首启引导路径（admins 非空后环境变量不再生效，
 * 避免运维改 env 覆盖面板内已修改的密码）。登录页渲染与登录路由都会先调用它，
 * 保证 env 引导的实例在 /login 直接呈现登录表单而非"设置初始密码"。
 */
export async function ensureAdminFromEnv(db: Database.Database): Promise<boolean> {
  const password = process.env.PANEL_ADMIN_PASSWORD;
  if (!password) return false;
  const count = db.prepare("SELECT COUNT(*) AS c FROM admins").get() as { c: number };
  if (count.c > 0) return false;
  await createAdminIfEmpty(db, password);
  return true;
}

/** 遍历 admins 表验证密码（当前单管理员，循环为将来多管理员留余地） */
export async function verifyAdminPassword(db: Database.Database, password: string): Promise<boolean> {
  const rows = db.prepare("SELECT password_hash FROM admins").all() as {
    password_hash: string;
  }[];
  for (const row of rows) {
    if (await verifyPassword(password, row.password_hash)) return true;
  }
  return false;
}

/** 改密码：先验旧密码再写新哈希；旧密码不符返回 false 不改动。
 *  只改密码本体——不吊销已签发的 API token（有独立的吊销入口），
 *  也不轮换 session_secret（那会踢掉包括当前在内的全部会话，超出改密语义）。 */
export async function changeAdminPassword(
  db: Database.Database,
  oldPassword: string,
  newPassword: string,
): Promise<boolean> {
  if (!(await verifyAdminPassword(db, oldPassword))) return false;
  const hash = await hashPassword(newPassword);
  db.prepare("UPDATE admins SET password_hash = ? WHERE id = (SELECT MIN(id) FROM admins)").run(hash);
  return true;
}
