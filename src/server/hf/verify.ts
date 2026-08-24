import { HubApiError, whoAmI } from "@huggingface/hub";
import { makeProxyFetch, type HfOptions } from "./client";

/**
 * 「测试连接」（M2 Task 9）：用当前生效配置（resolveHfOptions 产出）调 hub 的
 * whoAmI，验证镜像端点连通性 / Token 有效性。POST /api/v1/settings/hf/test 的核心。
 *
 * whoAmI 实际 API 形态（node_modules/@huggingface/hub@2.15.0）：
 * `whoAmI({ hubUrl?, fetch?, accessToken? })` → GET `${hubUrl|HUB_URL}/api/whoami-v2`
 * （HUB_URL = https://huggingface.co），成功返回 `{ id, type, name, ..., auth }`
 * （type: user | org | app）；HTTP 非 2xx 抛 HubApiError（含 statusCode）。
 * 注意匿名语义：accessToken 缺省时库仍会发 `Authorization: Bearer undefined`，
 * HF 端必然 401 —— 因此「匿名 + 401」不代表失败，反而证明端点可达
 * （本机实测 hf-mirror.com 匿名/坏 Token 均回 401 "Invalid username or password."）。
 */

/** 连通测试结果：account 为账号名或字面量 "anonymous"（匿名可达） */
export interface HfTestResult {
  ok: true;
  account: string;
  /** true = 匿名（无 Token）状态下仅验证了端点连通 */
  anonymous: boolean;
}

/**
 * whoAmI 异常 → 面向用户的中文 Error。与 client.ts 的 mapHfError 同风格同口径：
 * - 401/403 → Token 无效（测试场景下没有 repo 维度，文案不含 gated repo）
 * - 429 → 限流提示
 * - 其余 HubApiError → 带状态码与原始 message
 * - 非 hub 异常（fetch 网络层 TypeError 等）→ HF 网络错误 + 原始 message
 */
export function mapWhoAmIError(e: unknown): Error {
  if (e instanceof HubApiError) {
    if (e.statusCode === 401 || e.statusCode === 403) {
      return new Error("Token 无效");
    }
    if (e.statusCode === 429) return new Error("HF 限流，建议配置 Token 或稍后重试");
    return new Error(`HF API 错误(HTTP ${e.statusCode}): ${e.message}`);
  }
  // fetch 网络层异常（如 TypeError: fetch failed）等非 hub 错误
  return new Error(`HF 网络错误: ${e instanceof Error ? e.message : String(e)}`);
}

/**
 * 异常裁决（提纯以便单测）：匿名 + 401 = 端点可达的成功语义；
 * 其余一律走 mapWhoAmIError 的失败映射。
 */
export function interpretWhoAmIError(e: unknown, anonymous: boolean): HfTestResult | Error {
  if (anonymous && e instanceof HubApiError && e.statusCode === 401) {
    return { ok: true, account: "anonymous", anonymous: true };
  }
  return mapWhoAmIError(e);
}

/** 用生效配置测连通：成功返回账号信息，失败抛中文 Error（路由层转 502） */
export async function testHfConnection(opts: HfOptions): Promise<HfTestResult> {
  // hub 的 checkCredentials 对非 hf_ 前缀令牌抛 TypeError，会与网络层 TypeError 混淆；
  // 这里前置拦截给出明确文案（PUT 校验允许 32+ 长令牌，此处如实指出其无法测试）
  if (opts.token !== undefined && !opts.token.startsWith("hf_")) {
    throw new Error("Token 格式错误: 必须以 hf_ 开头");
  }

  try {
    // CredentialsParams 是「accessToken | credentials 二选一」的 union，类型上
    // 无法表达匿名；但运行时 checkCredentials 允许两者皆缺（返回 undefined，
    // 随后发无效 Bearer 头、被 HF 以 401 拒绝——匿名语义见上注），故按参数
    // 类型断言传入（accessToken: undefined 即匿名）
    const params = {
      hubUrl: opts.endpoint,
      accessToken: opts.token,
      fetch: opts.proxy ? makeProxyFetch(opts.proxy) : undefined,
    } as Parameters<typeof whoAmI>[0];
    const info = await whoAmI(params);
    return { ok: true, account: info.name, anonymous: false };
  } catch (e) {
    const interpreted = interpretWhoAmIError(e, opts.token === undefined);
    if (interpreted instanceof Error) throw interpreted;
    return interpreted;
  }
}
