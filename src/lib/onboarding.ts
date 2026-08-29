/**
 * 首启动引导清单（UX P1 U22）：四步状态纯函数。判据全部从既有数据推导
 * （namespaces / models / events / settings 四张既有表各查一次），不新增埋点表。
 *
 * 命名空间一步默认已完成：main 空间在 repo 初始化时幂等自带（见
 * server/repo/models.ts），首启动即满足「存在任一命名空间」，把它当成
 * 「起点已就绪」的正反馈而非需要用户操作的一步。
 */
export interface OnboardingFacts {
  /** namespaces 表行数 */
  namespaceCount: number;
  /** models 表行数 */
  modelCount: number;
  /** events 表是否存在 kind='model.start' */
  everStarted: boolean;
  /** settings.onboarding_playground_seen === "1" */
  playgroundSeen: boolean;
}

export type OnboardingStepId = "namespace" | "model" | "start" | "playground";

export interface OnboardingStep {
  id: OnboardingStepId;
  done: boolean;
  /** 第一个未完成步骤为 true，用于高亮当前该做哪一步；全部完成时无步骤为 current */
  current: boolean;
  /** 该步的直达入口 */
  href: string;
}

/** 步骤顺序与直达链接固定，供前端渲染与测试共同依赖 */
const STEP_ORDER: ReadonlyArray<{ id: OnboardingStepId; href: string }> = [
  { id: "namespace", href: "/settings?tab=library" },
  { id: "model", href: "/models/new" },
  { id: "start", href: "/models" },
  { id: "playground", href: "/chat" },
];

export function onboardingSteps(facts: OnboardingFacts): OnboardingStep[] {
  const doneById: Record<OnboardingStepId, boolean> = {
    namespace: facts.namespaceCount > 0,
    model: facts.modelCount > 0,
    start: facts.everStarted,
    playground: facts.playgroundSeen,
  };

  const firstUndoneIndex = STEP_ORDER.findIndex((step) => !doneById[step.id]);

  return STEP_ORDER.map((step, index) => ({
    id: step.id,
    href: step.href,
    done: doneById[step.id],
    current: index === firstUndoneIndex,
  }));
}

export function isOnboardingComplete(steps: OnboardingStep[]): boolean {
  return steps.every((step) => step.done);
}
