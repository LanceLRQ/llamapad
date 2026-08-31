import { describe, expect, it } from "vitest";

import { WIZARD_STEPS, resolveWizardStep, wizardStepState } from "./wizard-steps";

describe("resolveWizardStep", () => {
  it("raw 为 undefined 落到第 1 步", () => {
    expect(resolveWizardStep(undefined, 1)).toBe(1);
  });

  it("raw 为非数字字符串落到第 1 步", () => {
    expect(resolveWizardStep("abc", 2)).toBe(1);
  });

  it('raw 为 "0" 落到第 1 步（步骤从 1 开始，0 不是合法步骤）', () => {
    expect(resolveWizardStep("0", 2)).toBe(1);
  });

  it('raw 为 "5"（超出向导总步数 2）回落到 maxReached 与总步数中较小者', () => {
    expect(resolveWizardStep("5", 1)).toBe(1);
    // maxReached 本身超过总步数 2 时（理论上不该发生，防御性夹到 2）
    expect(resolveWizardStep("5", 10)).toBe(2);
  });

  it("raw 指向未解锁步骤（大于 maxReached）时回落到 maxReached", () => {
    expect(resolveWizardStep("2", 1)).toBe(1);
  });

  it("raw 恰好等于 maxReached 时原样返回", () => {
    expect(resolveWizardStep("2", 2)).toBe(2);
  });

  it("raw 指向已解锁的更早步骤时原样返回（深链回到已完成步）", () => {
    expect(resolveWizardStep("1", 2)).toBe(1);
  });
});

describe("wizardStepState", () => {
  it("current=1, maxReached=1：第 1 步 current，第 2 步 locked（刚打开向导）", () => {
    const states = WIZARD_STEPS.map((step) => wizardStepState(step, 1, 1));
    expect(states).toEqual(["current", "locked"]);
  });

  it("current=2, maxReached=2：第 1 步 done，第 2 步 current（顺序走到第 2 步）", () => {
    const states = WIZARD_STEPS.map((step) => wizardStepState(step, 2, 2));
    expect(states).toEqual(["done", "current"]);
  });

  it("current=1, maxReached=2：已经走到第 2 步又退回第 1 步——第 2 步仍是 done 而不是 " +
    "locked（走过的数据还在，点回去合法）", () => {
    const states = WIZARD_STEPS.map((step) => wizardStepState(step, 1, 2));
    expect(states).toEqual(["current", "done"]);
  });
});
