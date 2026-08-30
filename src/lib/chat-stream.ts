/**
 * llama-server 流式补全的单行 SSE 解析（自建 Playground）
 *
 * 报文形态取自真机实测（build b10450）：每帧一行 `data: {json}`，帧间空行，
 * 末尾 `data: [DONE]`。三处不能想当然：
 * 1. 首帧是 {"role":"assistant","content":null}——content 是 null 不是空串，
 *    直接累加会把字面量 "null" 拼进正文
 * 2. reasoning_content 与 content 是两条独立增量流（Qwen3 先吐完思考再吐正文），
 *    不分开处理短回复看起来就是"AI 没说话"
 * 3. finish_reason 帧带 timings，predicted_per_second 直接可用，不必自己掐表
 *
 * 本函数只解析**一行**：跨块的行拼接交给 core/line-splitter.ts（已有，日志流同款）。
 * 任何解析失败都返回空列表而非抛错——流式解析里抛异常会把整轮对话打断，
 * 而丢一帧增量最多是少几个字。
 */

/** 末帧 timings（字段名转驼峰，值原样） */
export interface ChatTimings {
  promptN: number;
  promptMs: number;
  predictedN: number;
  predictedMs: number;
  predictedPerSecond: number;
}

export type ChatStreamEvent =
  | { type: "reasoning"; text: string }
  | { type: "content"; text: string }
  | { type: "done"; finishReason: string | null; timings: ChatTimings | null }
  | { type: "error"; message: string };

const DATA_PREFIX = "data: ";
const DONE_SENTINEL = "[DONE]";

function readTimings(raw: unknown): ChatTimings | null {
  if (raw === null || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" ? v : 0);
  return {
    promptN: num(t.prompt_n),
    promptMs: num(t.prompt_ms),
    predictedN: num(t.predicted_n),
    predictedMs: num(t.predicted_ms),
    predictedPerSecond: num(t.predicted_per_second),
  };
}

export function parseSseLine(line: string): ChatStreamEvent[] {
  if (!line.startsWith(DATA_PREFIX)) return [];
  const payload = line.slice(DATA_PREFIX.length);
  if (payload === DONE_SENTINEL) return [];

  let frame: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(payload);
    if (parsed === null || typeof parsed !== "object") return [];
    frame = parsed as Record<string, unknown>;
  } catch {
    return [];
  }

  const err = frame.error;
  if (err !== null && typeof err === "object" && "message" in err) {
    return [{ type: "error", message: String((err as { message: unknown }).message) }];
  }

  const choices = Array.isArray(frame.choices) ? frame.choices : [];
  const first = choices[0];
  if (first === undefined || typeof first !== "object") return [];
  const choice = first as Record<string, unknown>;
  const delta = (choice.delta ?? {}) as Record<string, unknown>;

  const events: ChatStreamEvent[] = [];
  // reasoning 在前：同帧兼有两者时，思考内容在语义上先于正文
  if (typeof delta.reasoning_content === "string" && delta.reasoning_content !== "") {
    events.push({ type: "reasoning", text: delta.reasoning_content });
  }
  if (typeof delta.content === "string" && delta.content !== "") {
    events.push({ type: "content", text: delta.content });
  }
  if (typeof choice.finish_reason === "string") {
    events.push({
      type: "done",
      finishReason: choice.finish_reason,
      timings: readTimings(frame.timings),
    });
  }
  return events;
}
