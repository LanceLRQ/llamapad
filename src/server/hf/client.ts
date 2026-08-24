import { listFiles, HubApiError, type ListFileEntry } from "@huggingface/hub";
import { ProxyAgent } from "undici";
import { getDb } from "../db";
import { getPanelConfig } from "../panelConfig";

/** HF 客户端可注入项：镜像端点 / 访问令牌 / 出站代理（均为可选） */
export interface HfOptions {
  /** hub API 基址，如 https://hf-mirror.com；undefined = 官方默认 */
  endpoint?: string;
  /** hf_ 开头的访问令牌；undefined = 匿名 */
  token?: string;
  /** 出站代理 URL（panel.yaml 的 proxy），如 http://127.0.0.1:7890 */
  proxy?: string;
}

/** 对外条目：与 core/quant.ts 的 RepoFile 结构兼容（LFS 文件 oid 为内容 sha256） */
export interface HfRepoFile {
  path: string;
  size: number;
  oid?: string;
}

/**
 * 构造带代理的 fetch：Node 的全局 fetch 即 undici，识别 init.dispatcher 字段，
 * 传 ProxyAgent 实例即让本次（且仅本次）请求走代理，不动全局 dispatcher。
 */
function makeProxyFetch(proxy: string): typeof fetch {
  const dispatcher = new ProxyAgent({ uri: proxy });
  return (input, init) => fetch(input, { ...init, dispatcher } as RequestInit);
}

/** 把 hub/网络层异常翻译成面向用户的中文 Error（message 契约见下载向导设计） */
function mapHfError(e: unknown, repo: string): Error {
  if (e instanceof HubApiError) {
    if (e.statusCode === 401 || e.statusCode === 403) {
      return new Error("Token 无效或仓库受限（gated repo 需要在 HF 页面申请）");
    }
    if (e.statusCode === 404) return new Error(`仓库不存在: ${repo}`);
    if (e.statusCode === 429) return new Error("HF 限流，建议配置 Token 或稍后重试");
    return new Error(`HF API 错误(HTTP ${e.statusCode}): ${e.message}`);
  }
  // fetch 网络层异常（如 TypeError: fetch failed）等非 hub 错误
  return new Error(`HF 网络错误: ${e instanceof Error ? e.message : String(e)}`);
}

/**
 * 列出 HF 仓库（model repo）的全部文件（recursive，hub 内部跟随 Link 分页）。
 * - LFS 文件：size/oid 取自 lfs 字段（oid 即内容 sha256，供下载校验）
 * - 普通文件：size 取自身；oid 丢弃（git blob sha 非内容哈希，对下载校验无用）
 * - 目录条目排除（本函数语义是"文件列表"）
 * - 失败时抛中文 Error（见 mapHfError），调用方直接把 message 展示给用户
 */
export async function listRepoFiles(repo: string, opts?: HfOptions): Promise<HfRepoFile[]> {
  const entries: ListFileEntry[] = [];
  try {
    for await (const entry of listFiles({
      repo,
      recursive: true,
      hubUrl: opts?.endpoint,
      accessToken: opts?.token,
      fetch: opts?.proxy ? makeProxyFetch(opts.proxy) : undefined,
    })) {
      entries.push(entry);
    }
  } catch (e) {
    throw mapHfError(e, repo);
  }

  const files: HfRepoFile[] = [];
  for (const entry of entries) {
    if (entry.type === "directory") continue;
    files.push(
      entry.lfs
        ? { path: entry.path, size: entry.lfs.size, oid: entry.lfs.oid }
        : { path: entry.path, size: entry.size, oid: undefined },
    );
  }
  return files;
}

/**
 * 组装生产环境 HF 客户端配置（route handlers 每次请求调用，不缓存——Token 可能在面板里刚改过）：
 * - token：环境变量 HF_TOKEN 优先（部署方兜底），否则取 hf_token 表首行（created_at 最早的一条）
 * - endpoint：settings 表 key=hf_mirror，值为 official 或未设置 → undefined（官方默认）
 * - proxy：panel.yaml 的 proxy 字段（基础设施配置，与 undici ProxyAgent 共用）
 */
export async function resolveHfOptions(): Promise<HfOptions> {
  const db = getDb();
  const opts: HfOptions = {};

  const envToken = process.env.HF_TOKEN?.trim();
  if (envToken) {
    opts.token = envToken;
  } else {
    const row = db.prepare("SELECT token FROM hf_token ORDER BY created_at, rowid LIMIT 1").get() as
      | { token: string }
      | undefined;
    if (row) opts.token = row.token;
  }

  const mirror = db.prepare("SELECT value FROM settings WHERE key = 'hf_mirror'").get() as
    | { value: string }
    | undefined;
  if (mirror && mirror.value !== "official") opts.endpoint = mirror.value;

  const proxy = getPanelConfig().proxy;
  if (proxy) opts.proxy = proxy;

  return opts;
}
