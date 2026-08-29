import { describe, expect, it } from "vitest";

import { WIZARD_STEPS, resolveWizardStep, wizardStepState } from "./wizard-steps";

describe("resolveWizardStep", () => {
  it("raw 为 undefined 落到第 1 步", () => {
    expect(resolveWizardStep(undefined, 1)).toBe(1);
  });

  it("raw 为非数字字符串落到第 1 步", () => {
    expect(resolveWizardStep("abc", 3)).toBe(1);
  });

  it('raw 为 "0" 落到第 1 步（步骤从 1 开始，0 不是合法步骤）', () => {
    expect(resolveWizardStep("0", 4)).toBe(1);
  });

  it('raw 为 "5"（超出向导总步数）回落到 maxReached 与总步数中较小者', () => {
    expect(resolveWizardStep("5", 3)).toBe(3);
    // maxReached 本身超过总步数 4 时（理论上不该发生，防御性夹到 4）
    expect(resolveWizardStep("5", 10)).toBe(4);
  });

  it("raw 指向未解锁步骤（大于 maxReached）时回落到 maxReached", () => {
    expect(resolveWizardStep("3", 2)).toBe(2);
  });

  it("raw 恰好等于 maxReached 时原样返回", () => {
    expect(resolveWizardStep("3", 3)).toBe(3);
  });

  it("raw 指向已解锁的更早步骤时原样返回（深链回到已完成步）", () => {
    expect(resolveWizardStep("2", 4)).toBe(2);
  });
});

describe("wizardStepState", () => {
  it("current=1, maxReached=1：第 1 步 current，其余全部 locked（刚打开向导）", () => {
    const states = WIZARD_STEPS.map((step) => wizardStepState(step, 1, 1));
    expect(states).toEqual(["current", "locked", "locked", "locked"]);
  });

  it("current=3, maxReached=3：前两步 done，第 3 步 current，第 4 步 locked（顺序走到第 3 步）", () => {
    const states = WIZARD_STEPS.map((step) => wizardStepState(step, 3, 3));
    expect(states).toEqual(["done", "done", "current", "locked"]);
  });

  it("current=2, maxReached=4：已经走到第 4 步又退回第 2 步——第 1 步 done、第 2 步 current，" +
    "第 3/4 步仍是 done 而不是 locked（走过的数据还在，点回去合法）", () => {
    const states = WIZARD_STEPS.map((step) => wizardStepState(step, 2, 4));
    expect(states).toEqual(["done", "current", "done", "done"]);
  });
});
