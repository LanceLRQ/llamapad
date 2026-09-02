import { describe, expect, it } from "vitest";

import { cliFlagGroups } from "./readme-cli-block";

describe("cliFlagGroups", () => {
  it("抽出 shell 块里的 llama-server 命令并解析长参数", () => {
    const md = [
      "```bash",
      "llama-server --model x.gguf --temp 1.0 --top-k 20",
      "```",
    ].join("\n");
    expect(cliFlagGroups(md)[0].flags).toEqual([
      { flag: "--model", value: "x.gguf" },
      { flag: "--temp", value: "1.0" },
      { flag: "--top-k", value: "20" },
    ]);
  });

  it("合并反斜杠续行（HauhauCS 与 unsloth 都是这种写法）", () => {
    const md = [
      "```bash",
      "./build/bin/llama-server \\",
      "  --ctx-size 204800 \\",
      "  --temp 1.0",
      "```",
    ].join("\n");
    expect(cliFlagGroups(md)[0].flags).toEqual([
      { flag: "--ctx-size", value: "204800" },
      { flag: "--temp", value: "1.0" },
    ]);
  });

  it("tab 缩进的续行同样合并（unsloth/DeepSeek-R1 用的是 tab）", () => {
    const md = ["```bash", "./llama.cpp/llama-cli \\", "\t  --temp 0.6 \\", "\t  --ctx-size 8192", "```"].join("\n");
    expect(cliFlagGroups(md)[0].flags).toEqual([
      { flag: "--temp", value: "0.6" },
      { flag: "--ctx-size", value: "8192" },
    ]);
  });

  it("--flag=value 形态", () => {
    const md = "```bash\nllama-server --temp=0.7 --top-p=0.8\n```";
    expect(cliFlagGroups(md)[0].flags).toEqual([
      { flag: "--temp", value: "0.7" },
      { flag: "--top-p", value: "0.8" },
    ]);
  });

  it("负数当值而不是下一个参数（TheBloke 的 -n -1）", () => {
    const md = '```shell\n./main -ngl 35 -n -1 --temp 0.7\n```';
    expect(cliFlagGroups(md)[0].flags).toEqual([
      { flag: "-ngl", value: "35" },
      { flag: "-n", value: "-1" },
      { flag: "--temp", value: "0.7" },
    ]);
  });

  it("带引号的值整体作为一个 token（TheBloke 的 -p \"<s>[INST]…\"）", () => {
    const md = '```shell\n./main --temp 0.7 -p "<s>[INST] {prompt} [/INST]"\n```';
    const flags = cliFlagGroups(md)[0].flags;
    expect(flags).toContainEqual({ flag: "-p", value: '"<s>[INST] {prompt} [/INST]"' });
    expect(flags).toContainEqual({ flag: "--temp", value: "0.7" });
  });

  it("无值开关的 value 为空串（--jinja）", () => {
    const md = "```bash\nllama-server --jinja --temp 1.0\n```";
    expect(cliFlagGroups(md)[0].flags).toContainEqual({ flag: "--jinja", value: "" });
  });

  it("非 shell 语言的代码块跳过（python 块里的 temperature=0.7 不是命令行）", () => {
    const md = "```python\nllama_server(temperature=0.7)\n```";
    expect(cliFlagGroups(md)).toEqual([]);
  });

  it("shell 块里没有 llama-* 命令的一律跳过（编译步骤、openssl 校验等）", () => {
    const md = "```bash\ncmake --build build --config Release -j\n```";
    expect(cliFlagGroups(md)).toEqual([]);
  });

  it("同一份 README 里多个命令块各成一组", () => {
    const md = [
      "```bash", "llama-cli --temp 0.6", "```",
      "文字",
      "```bash", "llama-cli --temp 0.6 --n-gpu-layers 7", "```",
    ].join("\n");
    expect(cliFlagGroups(md)).toHaveLength(2);
  });

  it("环境变量前缀不影响识别（CUDA_VISIBLE_DEVICES=0 ./build/bin/llama-server …）", () => {
    const md = "```bash\nCUDA_VISIBLE_DEVICES=0 ./build/bin/llama-server --temp 1.0\n```";
    expect(cliFlagGroups(md)[0].flags).toEqual([{ flag: "--temp", value: "1.0" }]);
  });

  it("excerpt 保留原始命令行供用户核对", () => {
    const md = "```bash\nllama-server --temp 1.0\n```";
    expect(cliFlagGroups(md)[0].excerpt).toContain("llama-server --temp 1.0");
  });

  it("空输入不抛", () => {
    expect(cliFlagGroups("")).toEqual([]);
  });
});
