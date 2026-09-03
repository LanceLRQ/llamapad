import { describe, expect, it } from "vitest";

import { verifyValue } from "./readme-verify";

const R1 = "Set the temperature within the range of 0.5-0.7 (0.6 is recommended) to prevent endless repetitions.";

describe("verifyValue 数值通道", () => {
  it("原样出现即命中，并带回命中所在的整句", () => {
    const hit = verifyValue(0.6, R1);
    expect(hit).not.toBeNull();
    expect(hit!.sentence).toContain("0.6 is recommended");
  });

  it("小数尾零等值命中：README 写 0.60，AI 给 0.6", () => {
    expect(verifyValue(0.6, "use temp 0.60 for best results")).not.toBeNull();
  });

  it("千分位逗号等值命中：README 写 32,768，AI 给 32768", () => {
    expect(verifyValue(32768, "context length is 32,768 tokens")).not.toBeNull();
  });

  it("整数与浮点写法等值命中：README 写 1.0，AI 给 1", () => {
    expect(verifyValue(1, "repeat_penalty 1.0")).not.toBeNull();
  });

  // 这条是数值通道存在的全部理由：字符串 includes 会把 "0.6" 在 "10.65" 里认成命中
  it("不做子串匹配：0.6 不命中 10.65", () => {
    expect(verifyValue(0.6, "the value is 10.65 here")).toBeNull();
  });

  it("范围值不算命中：原文只写了 0.5-0.7 时 0.6 不命中", () => {
    expect(verifyValue(0.6, "temperature in the range 0.5-0.7")).toBeNull();
  });

  it("不做单位换算：32768 不命中 32k", () => {
    expect(verifyValue(32768, "context 32k tokens")).toBeNull();
  });

  it("负数命中", () => {
    expect(verifyValue(-1, "set dry_penalty_last_n to -1")).not.toBeNull();
  });
});

describe("verifyValue 字符串与布尔通道", () => {
  it("字符串归一化后原样命中", () => {
    expect(verifyValue("q8_0", "--cache-type-k q8_0 --cache-type-v q8_0")).not.toBeNull();
  });

  it("大小写不敏感", () => {
    expect(verifyValue("Q8_0", "use q8_0 for the kv cache")).not.toBeNull();
  });

  it("布尔按字面量命中", () => {
    expect(verifyValue(true, "set enable_thinking: true")).not.toBeNull();
    expect(verifyValue(false, "set enable_thinking: true")).toBeNull();
  });

  it("原文里没有就是没有", () => {
    expect(verifyValue("q4_0", "--cache-type-k q8_0")).toBeNull();
  });
});

describe("命中句定位", () => {
  it("按句末标点切句，不把整段带出来", () => {
    const body = "First sentence here. Set temperature to 0.6 now. Third sentence.";
    const hit = verifyValue(0.6, body);
    expect(hit!.sentence).toBe("Set temperature to 0.6 now.");
  });

  it("中文句号同样切句", () => {
    const body = "这是第一句。温度建议设为 0.6 效果最好。这是第三句。";
    expect(verifyValue(0.6, body)!.sentence).toBe("温度建议设为 0.6 效果最好。");
  });

  it("换行也是句边界", () => {
    const body = "line one\ntemperature 0.6\nline three";
    expect(verifyValue(0.6, body)!.sentence).toBe("temperature 0.6");
  });

  it("超长句硬截到 200 字符（与既有 excerpt 同口径）", () => {
    const body = `${"x".repeat(400)} 0.6 ${"y".repeat(400)}`;
    const hit = verifyValue(0.6, body);
    expect(hit!.sentence.length).toBeLessThanOrEqual(200);
    expect(hit!.sentence).toContain("0.6");
  });
});

describe("边界", () => {
  it("空原文一律不命中", () => {
    expect(verifyValue(0.6, "")).toBeNull();
  });

  it("null / undefined 值不命中，且不抛错", () => {
    expect(verifyValue(null, R1)).toBeNull();
    expect(verifyValue(undefined, R1)).toBeNull();
  });

  it("NaN 不命中", () => {
    expect(verifyValue(Number.NaN, "0.6")).toBeNull();
  });
});
