import { describe, expect, it } from "vitest";

import { kvGroups } from "./readme-kv";

describe("kvGroups", () => {
  it("一行多个内联 k=v（unsloth/Qwen3.8 的写法），label 取冒号前缀", () => {
    const md = [
      "## Best Practices",
      "",
      "1. **Sampling Parameters**:",
      "    - Thinking Mode: `temperature=1.0`, `top_p=0.95`, `top_k=20`",
      "    - Instruct (or non-thinking) mode: `temperature=0.7`, `top_p=0.80`",
    ].join("\n");
    const groups = kvGroups(md);

    expect(groups).toHaveLength(2);
    expect(groups[0].label).toBe("Thinking Mode");
    expect(groups[0].pairs).toEqual([
      { key: "temperature", value: "1.0" },
      { key: "top_p", value: "0.95" },
      { key: "top_k", value: "20" },
    ]);
    expect(groups[1].label).toBe("Instruct");
  });

  it("两套推荐同在一个标题下时不能都叫标题名 —— label 必须来自行内前缀", () => {
    const md = [
      "## Best Practices",
      "- Thinking Mode: `temperature=1.0`",
      "- Instruct mode: `temperature=0.7`",
    ].join("\n");
    expect(kvGroups(md).map((g) => g.label)).toEqual(["Thinking Mode", "Instruct mode"]);
  });

  it("粗体组标题 + 逐行 k=v 归成一组（HauhauCS 的写法）", () => {
    const md = [
      "## Recommended settings",
      "",
      "**Thinking mode (default):**",
      "",
      "- `temperature=1.0`",
      "- `top_p=0.95`",
      "- `reasoning_effort=xhigh`",
      "",
      "**Instruct / non-thinking mode:**",
      "",
      "- `temperature=0.7`",
      "- `enable_thinking=false`",
    ].join("\n");
    const groups = kvGroups(md);

    expect(groups).toHaveLength(2);
    expect(groups[0].label).toBe("Thinking mode (default)");
    expect(groups[0].pairs).toHaveLength(3);
    expect(groups[1].pairs).toEqual([
      { key: "temperature", value: "0.7" },
      { key: "enable_thinking", value: "false" },
    ]);
  });

  it("剥掉 blockquote 前缀（Qwen 官方把推荐写在 > [!Tip] 里）", () => {
    const md = [
      "> [!Tip]",
      "> We recommend using the following sets of sampling parameters:",
      "> - Thinking Mode: `temperature=1.0`, `top_p=0.95`",
    ].join("\n");
    expect(kvGroups(md)[0].pairs).toEqual([
      { key: "temperature", value: "1.0" },
      { key: "top_p", value: "0.95" },
    ]);
  });

  it("驼峰键原样抽出（归一化是 readme-params 的事）", () => {
    const md = [
      "## Best Practices",
      "- For thinking mode (`enable_thinking=True`), use `Temperature=0.6`, `TopP=0.95`, `MinP=0`",
    ].join("\n");
    expect(kvGroups(md)[0].pairs).toEqual([
      { key: "enable_thinking", value: "True" },
      { key: "Temperature", value: "0.6" },
      { key: "TopP", value: "0.95" },
      { key: "MinP", value: "0" },
    ]);
  });

  it("意图门控：不在推荐语境里的 k=v 一律不收", () => {
    const md = [
      "## Benchmarks",
      "- Evaluated with the Claude Code harness at `temp=1.0`, `top_p=0.95`",
    ].join("\n");
    expect(kvGroups(md)).toEqual([]);
  });

  it("行内自带推荐意图时不要求标题也命中", () => {
    const md = "- We recommend `temperature=0.6` for this model";
    expect(kvGroups(md)).toHaveLength(1);
  });

  it("冒号型键值一律不认 —— 规格表会被整片误收", () => {
    const md = [
      "## Recommended settings",
      "- Context Length: 262144",
      "- Number of Layers: 64",
    ].join("\n");
    expect(kvGroups(md)).toEqual([]);
  });

  it("非列表行不参与（散文里的 k=v 不收）", () => {
    const md = "## Recommended settings\n\nWe used temperature=0.6 in our tests.";
    expect(kvGroups(md)).toEqual([]);
  });

  it("代码块里的内容不参与（那是 readme-cli-block 的地盘）", () => {
    const md = "## Recommended settings\n\n```bash\nllama-server --temp 1.0\n```";
    expect(kvGroups(md)).toEqual([]);
  });

  it("label 清洗：去掉粗体符号、尾部标点与 use/using/for", () => {
    const md = "## Best Practices\n- **For non-thinking mode**, we suggest using `Temperature=0.7`";
    expect(kvGroups(md)[0].label).toBe("For non-thinking mode");
  });

  it("中文推荐语境同样命中", () => {
    const md = "## 推荐参数\n- 思考模式：`temperature=0.6`, `top_p=0.95`";
    expect(kvGroups(md)[0].pairs).toHaveLength(2);
  });

  it("excerpt 保留原始行", () => {
    const md = "## Recommended settings\n- Thinking: `temperature=1.0`";
    expect(kvGroups(md)[0].excerpt).toContain("temperature=1.0");
  });

  it("空输入不抛", () => {
    expect(kvGroups("")).toEqual([]);
  });

  it("独立粗体标题行：冒号在闭合 ** 之前与之后两种写法产出相同的 label（ReDoS 修复不能改行为）", () => {
    const beforeClose = [
      "## Recommended settings",
      "",
      "**Thinking mode:**",
      "",
      "- `temperature=1.0`",
    ].join("\n");
    const afterClose = [
      "## Recommended settings",
      "",
      "**Thinking mode**:",
      "",
      "- `temperature=1.0`",
    ].join("\n");

    expect(kvGroups(beforeClose)[0].label).toBe("Thinking mode");
    expect(kvGroups(afterClose)[0].label).toBe("Thinking mode");
  });

  it("独立粗体标题行不会因超长单行触发多项式回溯（ReDoS 回归钉子）", () => {
    // 构造一个恒不匹配的单行：多个 "**" + 大段空白 + 结尾非空白字符，是让旧的
    // 双 :? 结构反复回溯的典型输入；256KB 是 MAX_README_BYTES 的上限量级
    let line = "";
    for (let i = 0; i < 100; i++) line += `**${" ".repeat(2600)}`;
    line += "x";
    expect(line.length).toBeGreaterThan(200 * 1024);

    const t0 = performance.now();
    expect(kvGroups(`## settings\n${line}`)).toEqual([]);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(200);
  });
});
