/**
 * 外部上游的输入规范化（纯函数）：地址、名字、密钥尾号。
 *
 * 地址存的是「到 /v1 之前」的根：中转把客户端路径（/v1/chat/completions 等）原样
 * 拼在后面，用户照着 OpenAI 客户端的习惯把 /v1 也填进来时在这里去掉，否则会拼出
 * /v1/v1/…。不拦内网地址——登记者是已登录的管理员，访问内网服务正是这个功能的用途。
 */

export type UpstreamUrlResult = { ok: true; url: string } | { ok: false; reason: "invalid" | "protocol" };

/** 形如 `10.0.0.5:8080`（漏写 scheme）：URL 解析会失败，但应提示「协议」而非「无效」 */
const MISSING_SCHEME_PATTERN = /^[^\s/:]+:\d+(?:[/?#]|$)/;

export function normalizeUpstreamBaseUrl(raw: string): UpstreamUrlResult {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return { ok: false, reason: MISSING_SCHEME_PATTERN.test(raw.trim()) ? "protocol" : "invalid" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { ok: false, reason: "protocol" };

  let path = parsed.pathname.replace(/\/+$/, "");
  if (path.toLowerCase().endsWith("/v1")) path = path.slice(0, -3).replace(/\/+$/, "");
  // 用 host 而非 href 重组：顺带丢掉地址里的用户名密码、query 与 hash
  return { ok: true, url: `${parsed.protocol}//${parsed.host}${path}` };
}

/** 与托管模型同一条命名规则（core/schemas.ts 的 modelSchema.name） */
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** 与 /api/v1/upstreams 下的静态路径段冲突的名字 */
const RESERVED_NAMES = new Set(["test", "probe"]);

export function upstreamNameProblem(name: string): "format" | "reserved" | null {
  if (!NAME_PATTERN.test(name)) return "format";
  if (RESERVED_NAMES.has(name)) return "reserved";
  return null;
}

/**
 * 密钥会原样放进 Authorization 请求头：只允许可见 ASCII（不含空白与换行），
 * 否则构造请求头时会抛 TypeError。传入应已去首尾空白且非空
 */
export function apiKeyProblem(key: string): "format" | null {
  return /^[\x21-\x7E]+$/.test(key) ? null : "format";
}

/** 密钥的可辨识尾号：明文不出库，界面只展示这个 */
export function keyTail(key: string | null): string | null {
  if (key === null || key === "") return null;
  return key.slice(-4);
}
