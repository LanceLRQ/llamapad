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

/**
 * 把一次已确认为错误的响应体判成具体的 LlmError kind。
 * 调用方只在已经确定这是错误响应（!res.ok / 非流 / body 为空）时才调用它，
 * 所以它遍历所有分支都能给出一个具体分类，不存在"这不是错误"的返回路径
 * ——`| null` 是死代码（复核发现③），已去掉。
 */
export function classifyBody(status: number, bodyText: string): LlmError {
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

/**
 * 流中途收到的 error 帧（OpenAI 生态常见：HTTP 200 + event-stream 先过了
 * 响应头预检，读到一半才发一帧 `data: {"error":{...}}`，往往不发 [DONE] 就
 * 直接关连接）。判定复用 `classifyBody` 的限流关键词，不重抄一份关键词表。
 */
function classifyStreamError(message: string): LlmError {
  if (RATE_LIMIT_PATTERN.test(message)) {
    return new LlmError("rateLimited", "服务商限流，稍后重试");
  }
  return new LlmError("badResponse", message === "" ? "服务返回了错误" : message);
}

/**
 * 传输层失败的统一判定：fetch 本身失败、或已进入读流阶段后连接中断/被 abort，
 * 两处触发点共用同一套逻辑——优先看 signal 是否已被取消，其次把原始错误消息透传出去。
 */
function classifyTransportError(signal: AbortSignal, error: unknown): LlmError {
  if (signal.aborted) return new LlmError("network", "已取消");
  return new LlmError("network", error instanceof Error ? error.message : String(error));
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
    throw classifyTransportError(input.signal, error);
  }

  const contentType = res.headers.get("content-type") ?? "";
  // 不是流就一定不正常——包括 HTTP 200 携带 error 体的限流
  if (!res.ok || !contentType.includes("event-stream") || res.body === null) {
    throw classifyBody(res.status, await res.text());
  }

  let content = "";
  let streamError: string | null = null;
  const splitter = new LineSplitter((line) => {
    for (const event of parseSseLine(line)) {
      if (event.type === "reasoning") input.onDelta({ kind: "reasoning", text: event.text });
      else if (event.type === "content") {
        content += event.text;
        input.onDelta({ kind: "content", text: event.text });
      } else if (event.type === "error") {
        // 帧内错误不能就地 throw：这个回调跑在 LineSplitter 内部，抛出会
        // 穿过下面的读流循环变成一个未分类的裸异常。先记下第一条，
        // 等流读完（或读流本身失败）后统一分类
        streamError ??= event.message;
      }
    }
  });

  try {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      splitter.push(decoder.decode(value, { stream: true }));
    }
    splitter.flush();
  } catch (error) {
    // 连接中途被 RST、或请求已发出后才 abort（已进入读流阶段），
    // 都会让 reader.read() 抛错——同样走传输层判定，不能裸奔出去
    throw classifyTransportError(input.signal, error);
  }

  // 流里报过错就不算成功，哪怕前面已经吐了一些 content——半截结果比没有更危险，
  // 会让下游把"服务商中途报错"当成"模型给出的部分正文"
  if (streamError !== null) throw classifyStreamError(streamError);

  // 流正常结束却一个字都没有：这是失败，不是"模型认为 README 里没参数"——
  // 后者按 prompt 契约会给 {"profiles":[]}。返回空串会被下游当成后者，
  // 等于把服务端故障说成"没找到"
  if (content === "") throw new LlmError("badResponse", "模型没有返回任何内容");

  return content;
}
