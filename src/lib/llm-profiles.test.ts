import { describe, expect, it } from "vitest";

import { buildLlmProfiles } from "./llm-profiles";

const BODY = "Set the temperature within the range of 0.5-0.7 (0.6 is recommended). Use top_p 0.95.";

describe("buildLlmProfiles", () => {
  it("回证通过的字段进 server，并记下命中句", () => {
    const out = buildLlmProfiles(
      { profiles: [{ label: "Recommended", params: { temp: 0.6, top_p: 0.95 } }] },
      BODY,
    );

    expect(out.profiles).toHaveLength(1);
    expect(out.profiles[0]!.server).toEqual({ temp: 0.6, top_p: 0.95 });
    expect(out.profiles[0]!.source).toBe("llm");
    expect(out.profiles[0]!.label).toBe("Recommended");
    expect(out.profiles[0]!.hits!.temp).toContain("0.6 is recommended");
  });

  // 幻觉的典型形态：值合法、字段合法，就是原文里没写过
  it("回证不过的字段被丢弃并计数", () => {
    const out = buildLlmProfiles(
      { profiles: [{ label: "X", params: { temp: 0.6, top_k: 40 } }] },
      BODY,
    );

    expect(out.profiles[0]!.server).toEqual({ temp: 0.6 });
    expect(out.offered).toBe(2);
    expect(out.dropped).toBe(1);
  });

  it("超出字段 schema 值域的一律丢弃，不钳", () => {
    const out = buildLlmProfiles({ profiles: [{ label: "X", params: { temp: 5 } }] }, "temp 5");
    expect(out.profiles).toHaveLength(0);
    expect(out.dropped).toBe(1);
  });

  it("认不出的字段进 extras，不算 dropped", () => {
    const out = buildLlmProfiles(
      { profiles: [{ label: "X", params: { temp: 0.6, "spec-type": "draft-mtp" } }] },
      BODY,
    );

    expect(out.profiles[0]!.extras).toEqual([{ flag: "spec-type", value: "draft-mtp" }]);
    expect(out.dropped).toBe(0);
  });

  it("一个字段都没剩的 profile 整条丢掉", () => {
    const out = buildLlmProfiles({ profiles: [{ label: "X", params: { top_k: 40 } }] }, BODY);
    expect(out.profiles).toHaveLength(0);
  });

  it("同义词归一化：repetition_penalty → repeat_penalty", () => {
    const out = buildLlmProfiles(
      { profiles: [{ label: "X", params: { repetition_penalty: 1.1 } }] },
      "repetition_penalty 1.1 works well",
    );
    expect(out.profiles[0]!.server).toEqual({ repeat_penalty: 1.1 });
  });

  it("label 缺失时给空串，由 UI 决定显示什么", () => {
    const out = buildLlmProfiles({ profiles: [{ params: { temp: 0.6 } }] }, BODY);
    expect(out.profiles[0]!.label).toBe("");
  });

  it("多套推荐各自成卡", () => {
    const body = "Thinking: temp 0.6. Non-thinking: temp 0.7.";
    const out = buildLlmProfiles(
      {
        profiles: [
          { label: "Thinking", params: { temp: 0.6 } },
          { label: "Non-thinking", params: { temp: 0.7 } },
        ],
      },
      body,
    );
    expect(out.profiles).toHaveLength(2);
    expect(out.profiles.map((p) => p.id)).toHaveLength(new Set(out.profiles.map((p) => p.id)).size);
  });

  it("字段签名相同的两套只留一套", () => {
    const out = buildLlmProfiles(
      {
        profiles: [
          { label: "A", params: { temp: 0.6 } },
          { label: "B", params: { temp: 0.6 } },
        ],
      },
      BODY,
    );
    expect(out.profiles).toHaveLength(1);
  });

  it("形状不对的输入一律产出空结果，不抛错", () => {
    expect(buildLlmProfiles({}, BODY).profiles).toEqual([]);
    expect(buildLlmProfiles({ profiles: "nope" }, BODY).profiles).toEqual([]);
    expect(buildLlmProfiles({ profiles: [null, 42] }, BODY).profiles).toEqual([]);
    expect(buildLlmProfiles({ profiles: [{ params: null }] }, BODY).profiles).toEqual([]);
  });

  it("confidence 恒为 medium —— AI 结果不该与规则结果同级", () => {
    const out = buildLlmProfiles({ profiles: [{ label: "X", params: { temp: 0.6 } }] }, BODY);
    expect(out.profiles[0]!.confidence).toBe("medium");
  });
});

describe("弱命中标记", () => {
  it("命中句里没有参数名时把字段记进 weakFields", () => {
    // top_p=0.95 那句带参数名（强），min_p=0 只在无关的 HTML 里出现过（弱）
    const body = 'set top_p 0.95 here.\n<p style="margin-bottom: 0;">footer</p>';
    const out = buildLlmProfiles(
      { profiles: [{ label: "A", params: { top_p: 0.95, min_p: 0 } }] },
      body,
    );
    expect(out.profiles[0]!.server).toEqual({ top_p: 0.95, min_p: 0 });
    expect(out.profiles[0]!.weakFields).toEqual(["min_p"]);
    // 弱命中仍算命中，不进 dropped
    expect(out.dropped).toBe(0);
    expect(out.offered).toBe(2);
  });

  it("全部强命中时不写 weakFields 这个键", () => {
    const out = buildLlmProfiles(
      { profiles: [{ label: "A", params: { temp: 0.6 } }] },
      "temperature 0.6 is recommended",
    );
    expect(out.profiles[0]!.server).toEqual({ temp: 0.6 });
    expect(out.profiles[0]).not.toHaveProperty("weakFields");
  });
});
