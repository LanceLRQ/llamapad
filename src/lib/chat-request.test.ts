import { describe, expect, it } from "vitest";
import { buildChatBody, isSendable, type ChatTurn } from "./chat-request";

const turn = (role: ChatTurn["role"], content: string, reasoning = ""): ChatTurn => ({
  role,
  content,
  reasoning,
});

describe("buildChatBody", () => {
  it("只含 messages 与 stream，不带任何采样参数", () => {
    expect(buildChatBody([], "你好")).toEqual({
      messages: [{ role: "user", content: "你好" }],
      stream: true,
    });
  });

  it("历史轮的 reasoning 不回传（思考内容不进下一轮上下文）", () => {
    const history = [turn("user", "问题"), turn("assistant", "答案", "一大段思考")];
    expect(buildChatBody(history, "追问")).toEqual({
      messages: [
        { role: "user", content: "问题" },
        { role: "assistant", content: "答案" },
        { role: "user", content: "追问" },
      ],
      stream: true,
    });
  });

  it("输入首尾空白被裁掉", () => {
    expect(buildChatBody([], "  你好  ").messages.at(-1)).toEqual({
      role: "user",
      content: "你好",
    });
  });
});

describe("isSendable", () => {
  it("有内容且不在流式中才可发送", () => {
    expect(isSendable("你好", false)).toBe(true);
  });
  it("纯空白不可发送", () => {
    expect(isSendable("   \n ", false)).toBe(false);
  });
  it("流式进行中不可发送", () => {
    expect(isSendable("你好", true)).toBe(false);
  });
});
