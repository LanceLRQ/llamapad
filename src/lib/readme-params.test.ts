import { describe, expect, it } from "vitest";

import { extractRecommendations, normalizeParamKey, toServerField } from "./readme-params";

describe("normalizeParamKey", () => {
  it.each([
    ["--temp", "temp"],
    ["--top-p", "top_p"],
    ["TopP", "top_p"],
    ["MinP", "min_p"],
    ["PresencePenalty", "presence_penalty"],
    ["--repeat_penalty", "repeat_penalty"],
    ["-ngl", "ngl"],
    ["--n-gpu-layers", "n_gpu_layers"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeParamKey(input)).toBe(expected);
  });
});

describe("toServerField", () => {
  it("四种拼法都落到同一个字段", () => {
    for (const k of ["temperature", "temp", "Temperature", "--temp"]) {
      expect(toServerField(k)).toBe("temp");
    }
  });

  it("HF/vLLM 的 repetition_penalty 与 llama.cpp 的 repeat_penalty 同字段", () => {
    expect(toServerField("repetition_penalty")).toBe("repeat_penalty");
    expect(toServerField("--repeat-penalty")).toBe("repeat_penalty");
  });

  it("-t 不是 temperature —— 它是 threads，认错就给用户一个 temp=12 的坏配置", () => {
    expect(toServerField("-t")).toBeNull();
    expect(toServerField("--threads")).toBeNull();
  });

  it("-c / -ngl / -fa 等短参数白名单命中", () => {
    expect(toServerField("-c")).toBe("ctx_size");
    expect(toServerField("-ngl")).toBe("gpu_layers");
    expect(toServerField("-fa")).toBe("flash_attention");
    expect(toServerField("-ctk")).toBe("cache_type_k");
  });

  it("--host 不映射 —— README 里的 host 是作者本机的绑定地址，不是推荐", () => {
    expect(toServerField("--host")).toBeNull();
  });

  it("面板不支持的参数不映射（进 extras）", () => {
    expect(toServerField("--spec-type")).toBeNull();
    expect(toServerField("--jinja")).toBeNull();
    expect(toServerField("--reasoning-format")).toBeNull();
  });
});

describe("extractRecommendations", () => {
  it("命令块 → 一套推荐，未映射的参数进 extras", () => {
    const md = [
      "```bash",
      "llama-server --model x.gguf --temp 1.0 --top-k 20 --jinja --threads 12 -n -1",
      "```",
    ].join("\n");
    const [profile] = extractRecommendations(md);

    expect(profile.server).toEqual({ temp: 1, top_k: 20 });
    expect(profile.source).toBe("cli-block");
    expect(profile.extras.map((e) => e.flag)).toEqual(
      expect.arrayContaining(["--model", "--jinja", "--threads", "-n"]),
    );
  });

  it("越界值直接丢弃而不是钳到边界（README 写 temp=5 就是 README 错了）", () => {
    const md = "```bash\nllama-server --temp 5 --top-p 0.9\n```";
    const [profile] = extractRecommendations(md);
    expect(profile.server).toEqual({ top_p: 0.9 });
    expect(profile.extras).toContainEqual({ flag: "--temp", value: "5" });
  });

  it("枚举值命中才收", () => {
    const md = "```bash\nllama-server --cache-type-k q8_0 --cache-type-v bogus --temp 1\n```";
    const [profile] = extractRecommendations(md);
    expect(profile.server.cache_type_k).toBe("q8_0");
    expect(profile.server.cache_type_v).toBeUndefined();
  });

  it("无值的 -fa 视作 on（老版本 llama.cpp 是纯开关）", () => {
    const md = "```bash\nllama-cli -fa --temp 0.6\n```";
    expect(extractRecommendations(md)[0].server.flash_attention).toBe("on");
  });

  it("--n-gpu-layers all 不硬猜成 999，进 extras", () => {
    const md = "```bash\nllama-server --n-gpu-layers all --temp 1.0\n```";
    const [profile] = extractRecommendations(md);
    expect(profile.server.gpu_layers).toBeUndefined();
    expect(profile.extras).toContainEqual({ flag: "--n-gpu-layers", value: "all" });
  });

  it("Python 风格的 True/False 归一化成布尔", () => {
    const md = "## Best Practices\n- Non-thinking (`enable_thinking=False`): `Temperature=0.7`";
    expect(extractRecommendations(md)[0].server.enable_thinking).toBe(false);
  });

  it("列表项两套推荐各成一条，label 可区分", () => {
    const md = [
      "## Best Practices",
      "- Thinking Mode: `temperature=1.0`, `top_p=0.95`, `top_k=20`",
      "- Instruct mode: `temperature=0.7`, `top_p=0.80`, `top_k=20`",
    ].join("\n");
    const profiles = extractRecommendations(md);

    expect(profiles).toHaveLength(2);
    expect(profiles.map((p) => p.label)).toEqual(["Thinking Mode", "Instruct mode"]);
    expect(profiles[0].server.temp).toBe(1);
    expect(profiles[1].server.temp).toBe(0.7);
  });

  it("只含单个性能类字段的片段丢弃（YaRN 长文本示例不是一套推荐）", () => {
    const md = "```bash\n./llama-cli ... -c 131072 --rope-scaling yarn\n```";
    expect(extractRecommendations(md)).toEqual([]);
  });

  it("含采样类字段就保留，哪怕只有一个", () => {
    const md = "```bash\nllama-cli --temp 0.6\n```";
    expect(extractRecommendations(md)).toHaveLength(1);
  });

  it("字段数 >=3 的纯性能组合保留（那是一套真的部署参数）", () => {
    const md = "```bash\nllama-server -ngl 99 -c 8192 -ctk q8_0\n```";
    expect(extractRecommendations(md)).toHaveLength(1);
  });

  it("同一份 README 里字段完全相同的两条去重，保留字段多的那条", () => {
    const md = [
      "```bash",
      "llama-server --temp 1.0 --top-p 0.95 --top-k 20",
      "```",
      "## Recommended settings",
      "- Thinking: `temperature=1.0`, `top_p=0.95`",
    ].join("\n");
    const profiles = extractRecommendations(md);
    expect(profiles.every((p, i, arr) => arr.findIndex((q) => q.id === p.id) === i)).toBe(true);
  });

  it("跨来源同签名合并为一条，保留带 label 的 kv-list（修复钉住用例）", () => {
    const md = [
      "```bash",
      "llama-server --temp 0.6 --top-p 0.95",
      "```",
      "## Recommended settings",
      "- Thinking Mode: `temperature=0.6`, `top_p=0.95`",
    ].join("\n");
    const profiles = extractRecommendations(md);

    expect(profiles).toHaveLength(1);
    expect(profiles[0].source).toBe("kv-list");
    expect(profiles[0].label).toBe("Thinking Mode");
  });

  it("id 稳定：同样的输入两次产出同样的 id", () => {
    const md = "```bash\nllama-server --temp 0.6\n```";
    expect(extractRecommendations(md)[0].id).toBe(extractRecommendations(md)[0].id);
  });

  it("没有推荐时返回空数组，不是抛错也不是编一套", () => {
    expect(extractRecommendations("# 标题\n\n普通正文，没有任何参数")).toEqual([]);
  });

  it("excerpt 非空，供用户核对出处", () => {
    const md = "```bash\nllama-server --temp 0.6\n```";
    expect(extractRecommendations(md)[0].excerpt).toContain("--temp 0.6");
  });

  it("CRLF 行尾不影响抽取结果（Windows 侧编辑并 push 的 HF 仓库会带 \\r\\n，" +
    "readme-cli-block.ts 的 fence 正则要求 ``` 语言标记后紧跟 \\n，" +
    "\\r 留在前缀里会让整段命令块匹配失败、静默归零）", () => {
    const lf = ["```bash", "llama-server --temp 1.0 --top-k 20", "```"].join("\n");
    const crlf = lf.replace(/\n/g, "\r\n");

    expect(extractRecommendations(crlf)).toEqual(extractRecommendations(lf));
    expect(extractRecommendations(crlf)[0].server).toEqual({ temp: 1, top_k: 20 });
  });
});
