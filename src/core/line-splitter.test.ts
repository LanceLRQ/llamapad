import { describe, expect, it } from "vitest";
import { LineSplitter } from "./line-splitter";

/** 收集回调出的行，断言更直观 */
function collect(): { lines: string[]; splitter: LineSplitter } {
  const lines: string[] = [];
  return { lines, splitter: new LineSplitter((line) => lines.push(line)) };
}

describe("LineSplitter", () => {
  it("整块多行一次切出", () => {
    const { lines, splitter } = collect();
    splitter.push("a\nb\nc\n");
    expect(lines).toEqual(["a", "b", "c"]);
  });
  it("不完整的尾行留在缓冲，不提前吐出", () => {
    const { lines, splitter } = collect();
    splitter.push("a\nbc");
    expect(lines).toEqual(["a"]);
  });
  it("跨 chunk 的半行拼回完整行（docker 帧 / nvidia-smi 管道的真实形态）", () => {
    const { lines, splitter } = collect();
    splitter.push("0, 1024, 24");
    splitter.push("576, 30\n");
    expect(lines).toEqual(["0, 1024, 24576, 30"]);
  });
  it("一个 chunk 里含多个换行且以半行结尾", () => {
    const { lines, splitter } = collect();
    splitter.push("a\nb\nc");
    expect(lines).toEqual(["a", "b"]);
    splitter.push("d\n");
    expect(lines).toEqual(["a", "b", "cd"]);
  });
  it("行尾 \\r 剥掉（CRLF 流）", () => {
    const { lines, splitter } = collect();
    splitter.push("a\r\nb\r\n");
    expect(lines).toEqual(["a", "b"]);
  });
  it("空行原样保留（调用方自行过滤，不在此处吞掉）", () => {
    const { lines, splitter } = collect();
    splitter.push("a\n\nb\n");
    expect(lines).toEqual(["a", "", "b"]);
  });
  it("flush 把残留尾行作为最后一行补出", () => {
    const { lines, splitter } = collect();
    splitter.push("a\nb");
    splitter.flush();
    expect(lines).toEqual(["a", "b"]);
  });
  it("缓冲为空时 flush 不产多余空行", () => {
    const { lines, splitter } = collect();
    splitter.push("a\n");
    splitter.flush();
    splitter.flush();
    expect(lines).toEqual(["a"]);
  });
  it("接受 Buffer 输入（流的原生形态）", () => {
    const { lines, splitter } = collect();
    splitter.push(Buffer.from("中文行\n", "utf8"));
    expect(lines).toEqual(["中文行"]);
  });
  it("已知边界：多字节字符恰被 chunk 边界切断时会损坏（不修，见源码注释）", () => {
    const { lines, splitter } = collect();
    const bytes = Buffer.from("中\n", "utf8"); // 3 字节 + 换行
    splitter.push(bytes.subarray(0, 2)); // 切在字符中间
    splitter.push(bytes.subarray(2));
    // 钉死现状而非期望值：两半各自 toString 都产生替换字符，拼不回 "中"
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toBe("中");
  });
});
