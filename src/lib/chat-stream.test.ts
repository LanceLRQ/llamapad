import { describe, expect, it } from "vitest";
import { parseSseLine } from "./chat-stream";

const frame = (delta: unknown, extra = "") =>
  `data: {"choices":[{"finish_reason":null,"index":0,"delta":${JSON.stringify(delta)}}]${extra}}`;

describe("parseSseLine", () => {
  it("空行与非 data 行不产出事件", () => {
    expect(parseSseLine("")).toEqual([]);
    expect(parseSseLine(": keep-alive")).toEqual([]);
  });

  it("首帧的 content:null 不产出事件（拼上去会变成字面量 null）", () => {
    expect(parseSseLine(frame({ role: "assistant", content: null }))).toEqual([]);
  });

  it("content 增量产出 content 事件", () => {
    expect(parseSseLine(frame({ content: "递归是" }))).toEqual([
      { type: "content", text: "递归是" },
    ]);
  });

  it("reasoning_content 增量产出 reasoning 事件", () => {
    expect(parseSseLine(frame({ reasoning_content: "嗯" }))).toEqual([
      { type: "reasoning", text: "嗯" },
    ]);
  });

  it("同帧兼有两者时 reasoning 在前（防御性顺序）", () => {
    expect(parseSseLine(frame({ reasoning_content: "嗯", content: "递归" }))).toEqual([
      { type: "reasoning", text: "嗯" },
      { type: "content", text: "递归" },
    ]);
  });

  it("finish_reason 帧产出 done 并带上 timings", () => {
    const line =
      'data: {"choices":[{"finish_reason":"length","index":0,"delta":{}}],' +
      '"timings":{"prompt_n":14,"prompt_ms":92.458,"predicted_n":80,' +
      '"predicted_ms":3576.701,"predicted_per_second":22.087}}';
    expect(parseSseLine(line)).toEqual([
      {
        type: "done",
        finishReason: "length",
        timings: {
          promptN: 14,
          promptMs: 92.458,
          predictedN: 80,
          predictedMs: 3576.701,
          predictedPerSecond: 22.087,
        },
      },
    ]);
  });

  it("无 timings 的 finish 帧 timings 为 null", () => {
    const line = 'data: {"choices":[{"finish_reason":"stop","index":0,"delta":{}}]}';
    expect(parseSseLine(line)).toEqual([{ type: "done", finishReason: "stop", timings: null }]);
  });

  it("[DONE] 哨兵不产出事件（终止靠 body 关闭）", () => {
    expect(parseSseLine("data: [DONE]")).toEqual([]);
  });

  it("坏 JSON 不抛异常，静默跳过", () => {
    expect(parseSseLine("data: {不是 json")).toEqual([]);
  });

  it("流中错误帧产出 error 事件", () => {
    const line = 'data: {"error":{"code":400,"message":"Field x: bad"}}';
    expect(parseSseLine(line)).toEqual([{ type: "error", message: "Field x: bad" }]);
  });
});
