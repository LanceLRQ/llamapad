/**
 * 新建模型向导二级栏纯逻辑层（M16 T8）：`?step=` 深链解析 + 三态判定。对齐
 * lib/files-view.ts、lib/settings-tabs.ts 的既有做法（vitest 是
 * environment: "node"，组件渲染测不了，可测判定一律下沉到这里配 .test.ts）。
 *
 * 与设置页 / 文件页的二级栏不同：向导的「已解锁到第几步」（maxReached）不是
 * 一份可以从磁盘/db 读回的持久状态——它就是"这次打开向导，用户已经往前走到
 * 哪"，页面刷新即丢失也是有意为之（没走完的向导本来就没有可恢复的半成品）。
 * maxReached 由 wizard.tsx 的组件 state 维护（只增不减），本文件只负责纯计算。
 */

export const WIZARD_STEPS = [1, 2] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

export type WizardStepState = "done" | "current" | "locked";

const MIN_STEP: WizardStep = WIZARD_STEPS[0];
const MAX_STEP: WizardStep = WIZARD_STEPS[WIZARD_STEPS.length - 1];

/**
 * URL 里的 ?step= 落到实际步骤：受门禁约束——指向未解锁步骤时回落到当前可达的
 * 最大步。maxReached 由组件维护（只增不减），页面刷新后重置为 1，所以
 * `?step=3` 在新开的标签页里会落回 1：向导状态本来就没有持久化，深链能带你
 * 回到已经走过的步，不能凭空把你送进一个没有前置数据的步。
 */
export function resolveWizardStep(raw: string | undefined, maxReached: number): WizardStep {
  const parsed = raw === undefined ? NaN : Number(raw);
  if (!Number.isInteger(parsed) || parsed < MIN_STEP) return MIN_STEP;
  // maxReached 理论上不会超过 2（组件只会传入 1~2 之间的值），这里仍夹一手
  // 防御：万一传入越界值，也不能让解析结果跑出 WIZARD_STEPS 的范围
  const cap = Math.min(maxReached, MAX_STEP) as WizardStep;
  return Math.min(parsed, cap) as WizardStep;
}

/**
 * 每一步在二级栏里的三态：`step < current` → done；`step === current` →
 * current；`step > maxReached` → locked；`current < step <= maxReached` →
 * done（已经走过又退回来的时候，前面走过的后续步仍是 done 不是
 * locked——它们的数据还在，点回去是合法的）。
 */
export function wizardStepState(step: number, current: number, maxReached: number): WizardStepState {
  if (step === current) return "current";
  if (step < current) return "done";
  return step <= maxReached ? "done" : "locked";
}
