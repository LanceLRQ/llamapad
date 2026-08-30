/**
 * Playground 请求体组装（自建 Playground）
 *
 * **请求体刻意只含 messages 与 stream，一个采样参数都不带**——采样参数是
 * llama-server 的启动参数（core/args.ts 把 server 段映射成 --temp / --top-p …），
 * 客户端再发一遍就成了"覆盖"，会制造第二处状态源。不发 = 服务端配置即生效值，
 * 参数栏展示的东西才配叫"真的生效了"。
 *
 * 这也顺带让 Playground 天然免疫 llama.cpp Web UI 那类客户端脏值问题
 * （见 research/03-webui配置与dry_penalty_last_n.md）。
 *
 * max_tokens 同理不传：模型配置里本就没有这个字段，无从取值；生成过长靠"停止"收口。
 */

export interface ChatTurn {
  role: "user" | "assistant";
  /** 正文（已完成的那一轮） */
  content: string;
  /** 思考内容；仅用于界面折叠展示，不回传给模型 */
  reasoning: string;
}

export interface ChatRequestBody {
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  stream: true;
}

export function buildChatBody(history: readonly ChatTurn[], userInput: string): ChatRequestBody {
  return {
    messages: [
      ...history.map((t) => ({ role: t.role, content: t.content })),
      { role: "user" as const, content: userInput.trim() },
    ],
    stream: true,
  };
}

export function isSendable(input: string, streaming: boolean): boolean {
  return !streaming && input.trim() !== "";
}
