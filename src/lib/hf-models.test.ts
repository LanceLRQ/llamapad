import { describe, expect, it } from "vitest";

import {
  HF_DISCOVER_LIMIT,
  OFFICIAL_HF_ENDPOINT,
  hasMoreResults,
  hfListUrl,
  hfRepoUrl,
  parseLimit,
  resolveTrendingTtlMs,
  toModelSummary,
  type ModelEntryWithExtras,
} from "./hf-models";

const entry = (over: Partial<ModelEntryWithExtras> = {}): ModelEntryWithExtras => ({
  name: "unsloth/Qwen3.8-27B-GGUF",
  likes: 4440,
  downloads: 1908396,
  gated: false,
  task: "text-generation",
  updatedAt: new Date("2026-09-17T18:44:01.000Z"),
  trendingScore: 324,
  ...over,
});

describe("toModelSummary", () => {
  it("完整字段映射", () => {
    expect(toModelSummary(entry())).toEqual({
      repo: "unsloth/Qwen3.8-27B-GGUF",
      owner: "unsloth",
      name: "Qwen3.8-27B-GGUF",
      likes: 4440,
      downloads: 1908396,
      trending: 324,
      task: "text-generation",
      updatedAt: Date.parse("2026-09-17T18:44:01.000Z"),
      gated: false,
    });
  });

  it("trendingScore / task 缺失映射为 null", () => {
    const res = toModelSummary(entry({ trendingScore: undefined, task: undefined }));
    expect(res.trending).toBeNull();
    expect(res.task).toBeNull();
  });

  it("gated 是三值枚举：auto / manual 均为真，false 为假", () => {
    expect(toModelSummary(entry({ gated: "auto" })).gated).toBe(true);
    expect(toModelSummary(entry({ gated: "manual" })).gated).toBe(true);
    expect(toModelSummary(entry({ gated: false })).gated).toBe(false);
  });

  it("updatedAt 接受 Date 与 ISO 字符串，非法值落 0", () => {
    expect(toModelSummary(entry({ updatedAt: "2026-09-17T18:44:01.000Z" })).updatedAt).toBe(
      Date.parse("2026-09-17T18:44:01.000Z"),
    );
    expect(toModelSummary(entry({ updatedAt: "不是时间" })).updatedAt).toBe(0);
  });

  it("按第一个斜杠切 owner / name，无斜杠时 owner 为空", () => {
    expect(toModelSummary(entry({ name: "a/b/c" }))).toMatchObject({ owner: "a", name: "b/c" });
    expect(toModelSummary(entry({ name: "solo" }))).toMatchObject({ owner: "", name: "solo" });
  });
});

describe("hfRepoUrl", () => {
  it("官方与镜像端点各组装一份", () => {
    expect(hfRepoUrl("unsloth/x", OFFICIAL_HF_ENDPOINT)).toBe("https://huggingface.co/unsloth/x");
    expect(hfRepoUrl("unsloth/x", "https://hf-mirror.com")).toBe("https://hf-mirror.com/unsloth/x");
  });

  it("端点带尾斜杠时不产生双斜杠", () => {
    expect(hfRepoUrl("a/b", "https://hf-mirror.com/")).toBe("https://hf-mirror.com/a/b");
  });
});

describe("hfListUrl", () => {
  it("热门态带 sort=trending", () => {
    expect(hfListUrl("", "https://hf-mirror.com")).toBe(
      "https://hf-mirror.com/models?other=gguf&sort=trending",
    );
  });

  it("搜索态带 search 且不带 sort（HF 站内搜索默认按相关度排）", () => {
    expect(hfListUrl("qwen3", "https://hf-mirror.com")).toBe(
      "https://hf-mirror.com/models?search=qwen3&other=gguf",
    );
  });

  it("搜索词里的空格与斜杠被编码", () => {
    expect(hfListUrl("qwen 3/moe", OFFICIAL_HF_ENDPOINT)).toBe(
      "https://huggingface.co/models?search=qwen%203%2Fmoe&other=gguf",
    );
  });

  it("只含空白的搜索词按热门态处理", () => {
    expect(hfListUrl("   ", "https://hf-mirror.com")).toBe(
      "https://hf-mirror.com/models?other=gguf&sort=trending",
    );
  });
});

describe("resolveTrendingTtlMs", () => {
  it("缺省 30 分钟", () => {
    expect(resolveTrendingTtlMs(undefined)).toBe(30 * 60_000);
    expect(resolveTrendingTtlMs("")).toBe(30 * 60_000);
  });

  it("0 表示永不过期", () => {
    expect(resolveTrendingTtlMs("0")).toBe(Number.POSITIVE_INFINITY);
  });

  it("负数与非数字回落默认，不抛异常", () => {
    expect(resolveTrendingTtlMs("-5")).toBe(30 * 60_000);
    expect(resolveTrendingTtlMs("abc")).toBe(30 * 60_000);
  });

  it("正常值按分钟换算", () => {
    expect(resolveTrendingTtlMs("5")).toBe(5 * 60_000);
  });
});

describe("hasMoreResults", () => {
  it("够一屏才算还有更多", () => {
    expect(hasMoreResults(11, HF_DISCOVER_LIMIT)).toBe(false);
    expect(hasMoreResults(12, HF_DISCOVER_LIMIT)).toBe(true);
    expect(hasMoreResults(0, HF_DISCOVER_LIMIT)).toBe(false);
  });
});

describe("parseLimit", () => {
  it("缺省与非法值回落 12", () => {
    expect(parseLimit(null)).toBe(12);
    expect(parseLimit("abc")).toBe(12);
    expect(parseLimit("0")).toBe(12);
    expect(parseLimit("-3")).toBe(12);
    expect(parseLimit("1.5")).toBe(12);
  });

  it("超过上限夹到 50", () => {
    expect(parseLimit("500")).toBe(50);
  });

  it("合法值原样返回", () => {
    expect(parseLimit("24")).toBe(24);
  });
});
