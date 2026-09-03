import { LineSplitter } from "@/core/line-splitter";
import { mergeRequestBody } from "@/lib/llm-extra-body";
import { parseSseLine } from "@/lib/chat-stream";

/**
 * LLM 抽取引擎的公共部分（批 3）
 *
 * 接口刻意**不含 `rules`**：规则引擎是同步纯函数，既不流式也不会失败，
 * 为它包一层异步接口只会让调用方多一条无意义的分支。
 *
 * **失败判定一律看响应体，不看状态码**：实测某 provider 的限流走
 * HTTP 200 + `{"error":{"code":"1305",...}}`，而它的 `json_schema` 支持是
 * HTTP 200 + 一段散文。这类服务的失败经常不走状态码。
 */

export type LlmErrorKind =
  | "notConfigured"
  | "noRunningModel"
  | "unauthorized"
  | "rateLimited"
  | "network"
  | "badResponse";

export class LlmError extends Error {
  constructor(
    readonly kind: LlmErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

export interface EngineDelta {
  kind: "reasoning" | "content";
  text: string;
}

export interface ExtractEngine {
  id: "local" | "external";
  /** 实际使用的模型标识，落库并显示在卡头——用户需要知道这份结果是谁给的 */
  model: string;
  /** 跑一次抽取，流式回调增量，返回累积的**正文**（不含 reasoning） */
  run(input: {
    text: string;
    signal: AbortSignal;
    onDelta: (delta: EngineDelta) => void;
  }): Promise<string>;
}

/** 限流的通用特征。不同 provider 措辞不同，这里只认最普遍的几种，
 *  认不出就落到 badResponse——宁可提示得笼统，也不要把认证失败说成限流 */
const RATE_LIMIT_PATTERN = /rate.?limit|too many requests|访问量过大|请求过于频繁|quota|busy/i;

/** 把一次非流式的响应体判成具体的错误。返回 null 表示这不是错误 */
export function classifyBody(status: number, bodyText: string): LlmError | null {
  if (status === 401 || status === 403) {
    return new LlmError("unauthorized", "API Key 无效或没有权限");
  }
  if (status === 429) return new LlmError("rateLimited", "服务商限流，稍后重试");

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    /* 不是 JSON，走下面的 badResponse */
  }

  const error =
    parsed !== null && typeof parsed === "object"
      ? (parsed as { error?: unknown }).error
      : undefined;

  if (error !== null && typeof error === "object") {
    const message = String((error as { message?: unknown }).message ?? "");
    if (RATE_LIMIT_PATTERN.test(message)) {
      return new LlmError("rateLimited", "服务商限流，稍后重试");
    }
    return new LlmError("badResponse", message === "" ? "服务返回了错误" : message);
  }

  if (status >= 400) return new LlmError("network", `HTTP ${status}`);
  return new LlmError("badResponse", "服务没有返回流式响应");
}

/** 面板控制的核心请求语义，排在 extraBody 之后覆盖它 */
export function buildRequestBody(
  model: string,
  prompt: string,
  extraBody: Record<string, unknown> | null,
): Record<string, unknown> {
  return mergeRequestBody(extraBody, {
    model,
    messages: [{ role: "user", content: prompt }],
    stream: true,
    // 只用 json_object：json_schema 实测会静默失效（HTTP 200 吐散文），
    // 失效不体现在状态码上，"先探测再降级"探不出来
    response_format: { type: "json_object" },
  });
}

/**
 * 共用的流式读取：POST → 逐行 parseSseLine → 回调增量 → 返回累积正文。
 * 两个引擎的差别只在 URL 与 headers，读流这一段完全一样。
 */
export async function streamCompletions(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  doFetch: typeof fetch,
  input: { signal: AbortSignal; onDelta: (delta: EngineDelta) => void },
): Promise<string> {
  let res: Response;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: input.signal,
    });
  } catch (error) {
    if (input.signal.aborted) throw new LlmError("network", "已取消");
    throw new LlmError("network", error instanceof Error ? error.message : String(error));
  }

  const contentType = res.headers.get("content-type") ?? "";
  // 不是流就一定不正常——包括 HTTP 200 携带 error 体的限流
  if (!res.ok || !contentType.includes("event-stream") || res.body === null) {
    throw classifyBody(res.status, await res.text()) ?? new LlmError("badResponse", "未知响应");
  }

  let content = "";
  const splitter = new LineSplitter((line) => {
    for (const event of parseSseLine(line)) {
      if (event.type === "reasoning") input.onDelta({ kind: "reasoning", text: event.text });
      else if (event.type === "content") {
        content += event.text;
        input.onDelta({ kind: "content", text: event.text });
      }
    }
  });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    splitter.push(decoder.decode(value, { stream: true }));
  }
  splitter.flush();

  return content;
}
