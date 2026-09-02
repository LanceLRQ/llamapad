import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { extractRecommendations } from "./readme-params";

const fixture = (name: string): string =>
  readFileSync(join(__dirname, "__fixtures__", "readme", `${name}.md`), "utf8");

describe("真实 README 回归（语料见 docs/_internal/research/2026-09-02-readme样本/）", () => {
  it("unsloth/Qwen3.8-27B-GGUF：整篇无命令块，两套 kv 推荐", () => {
    const profiles = extractRecommendations(fixture("unsloth-qwen38"));

    expect(profiles).toHaveLength(2);
    expect(profiles.every((p) => p.source === "kv-list")).toBe(true);
    expect(profiles[0].label).toMatch(/Thinking/i);
    expect(profiles[0].server).toMatchObject({
      temp: 1, top_p: 0.95, top_k: 20, min_p: 0, presence_penalty: 0, repeat_penalty: 1,
    });
    expect(profiles[1].server).toMatchObject({ temp: 0.7, top_p: 0.8, presence_penalty: 1.5 });
  });

  it("HauhauCS：命令块 + 两套 kv，thinking 组带 reasoning_effort=xhigh", () => {
    const profiles = extractRecommendations(fixture("hauhaucs"));

    expect(profiles.length).toBeGreaterThanOrEqual(3);
    const thinking = profiles.find((p) => /Thinking/i.test(p.label));
    expect(thinking?.server.reasoning_effort).toBe("xhigh");

    const instruct = profiles.find((p) => /Instruct|non-thinking/i.test(p.label));
    expect(instruct?.server.enable_thinking).toBe(false);

    const cli = profiles.find((p) => p.source === "cli-block");
    expect(cli?.server).toMatchObject({ ctx_size: 204800, batch_size: 2048, temp: 1 });
    // 面板不支持的参数如实进 extras，不静默丢
    expect(cli?.extras.map((e) => e.flag)).toEqual(
      expect.arrayContaining(["--spec-type", "--jinja", "--no-mmap"]),
    );
  });

  it("Qwen 官方 3-32B-GGUF：驼峰写法归一化，YaRN 噪声片段被丢弃", () => {
    const profiles = extractRecommendations(fixture("qwen3-32b-gguf"));

    const thinking = profiles.find((p) => /thinking/i.test(p.label) && p.server.temp === 0.6);
    expect(thinking?.server).toMatchObject({ top_p: 0.95, top_k: 20, min_p: 0, presence_penalty: 1.5 });

    // 只含 ctx_size 一个性能类字段的 YaRN 示例不该成为一套推荐
    expect(profiles.some((p) => Object.keys(p.server).length === 1 && p.server.ctx_size === 131072)).toBe(false);
  });

  it("TheBloke：老式 ./main，下划线写法与负值都处理正确", () => {
    const [profile] = extractRecommendations(fixture("thebloke-mistral"));

    expect(profile.server).toEqual({ gpu_layers: 35, ctx_size: 32768, temp: 0.7, repeat_penalty: 1.1 });
    // -n -1 是 n_predict、-p 是提示词，都不能被当成采样参数
    expect(profile.extras.map((e) => e.flag)).toEqual(expect.arrayContaining(["-n", "-p"]));
  });

  it("bartowski：有 README 但没有推荐参数 —— 这是一半仓库的常态，必须是空数组而不是抛错", () => {
    expect(extractRecommendations(fixture("bartowski-empty"))).toEqual([]);
  });
});
