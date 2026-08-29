import { describe, expect, it } from "vitest";
import { onboardingSteps, isOnboardingComplete, type OnboardingFacts } from "./onboarding";

const facts = (o: Partial<OnboardingFacts> = {}): OnboardingFacts =>
  ({ namespaceCount: 1, modelCount: 0, everStarted: false, playgroundSeen: false, ...o });

describe("onboardingSteps", () => {
  it("四步顺序固定且首步默认完成（main 空间自带）", () => {
    const s = onboardingSteps(facts());
    expect(s.map((x) => x.id)).toEqual(["namespace", "model", "start", "playground"]);
    expect(s[0].done).toBe(true);
  });
  it("有模型后第二步点亮", () => {
    expect(onboardingSteps(facts({ modelCount: 2 }))[1].done).toBe(true);
  });
  it("current 指向第一个未完成步骤", () => {
    expect(onboardingSteps(facts({ modelCount: 1 })).find((x) => x.current)?.id).toBe("start");
  });
  it("全部完成时无 current", () => {
    const s = onboardingSteps(facts({ modelCount: 1, everStarted: true, playgroundSeen: true }));
    expect(s.some((x) => x.current)).toBe(false);
    expect(isOnboardingComplete(s)).toBe(true);
  });
  it("未完成时 isOnboardingComplete 为 false", () => {
    expect(isOnboardingComplete(onboardingSteps(facts()))).toBe(false);
  });
  it("每步都带直达链接", () => {
    expect(onboardingSteps(facts()).map((x) => x.href))
      .toEqual(["/settings?tab=library", "/models/new", "/models", "/chat"]);
  });
});
