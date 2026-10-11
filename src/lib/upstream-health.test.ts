import { describe, expect, it } from "vitest";
import {
  FAILURE_THRESHOLD,
  INITIAL_HEALTH,
  PROBE_INTERVAL_MS,
  applyOutcome,
  canActivate,
  isRoutable,
  markActivated,
  shouldPoll,
  transitionOf,
} from "./upstream-health";

const fail = { ok: false as const, error: "ECONNREFUSED" };
const ok = { ok: true as const };

describe("applyOutcome", () => {
  it("初始为 unknown；一次成功 → reachable", () => {
    expect(INITIAL_HEALTH.state).toBe("unknown");
    const next = applyOutcome(INITIAL_HEALTH, ok, 1000);
    expect(next).toMatchObject({ state: "reachable", failures: 0, lastCheckedAt: 1000, lastError: null });
  });

  it(`连续 ${FAILURE_THRESHOLD} 次失败才转 unreachable`, () => {
    let health = applyOutcome(INITIAL_HEALTH, ok, 1);
    health = applyOutcome(health, fail, 2);
    expect(health).toMatchObject({ state: "reachable", failures: 1, lastError: "ECONNREFUSED" });
    health = applyOutcome(health, fail, 3);
    expect(health.state).toBe("reachable");
    health = applyOutcome(health, fail, 4);
    expect(health).toMatchObject({ state: "unreachable", failures: 3, lastCheckedAt: 4 });
  });

  it("unknown 状态下失败同样累计到阈值", () => {
    let health = INITIAL_HEALTH;
    for (let i = 1; i <= FAILURE_THRESHOLD; i++) health = applyOutcome(health, fail, i);
    expect(health.state).toBe("unreachable");
  });

  it("中途一次成功清零失败计数", () => {
    let health = applyOutcome(INITIAL_HEALTH, fail, 1);
    health = applyOutcome(health, fail, 2);
    health = applyOutcome(health, ok, 3);
    health = applyOutcome(health, fail, 4);
    expect(health).toMatchObject({ state: "reachable", failures: 1 });
  });

  it("unreachable 时一次成功即恢复", () => {
    let health = INITIAL_HEALTH;
    for (let i = 1; i <= FAILURE_THRESHOLD; i++) health = applyOutcome(health, fail, i);
    expect(applyOutcome(health, ok, 99)).toMatchObject({ state: "reachable", failures: 0, lastError: null });
  });
});

describe("transitionOf", () => {
  it("只报告进入与离开 unreachable", () => {
    const up = applyOutcome(INITIAL_HEALTH, ok, 1);
    let down = up;
    for (let i = 2; i < 2 + FAILURE_THRESHOLD; i++) down = applyOutcome(down, fail, i);

    expect(transitionOf(INITIAL_HEALTH, up)).toBeNull();
    expect(transitionOf(up, down)).toBe("unreachable");
    expect(transitionOf(down, down)).toBeNull();
    expect(transitionOf(down, applyOutcome(down, ok, 50))).toBe("recovered");
  });
});

describe("调度判定", () => {
  it("unreachable 不参与定时探测，其余参与", () => {
    expect(shouldPoll("unknown")).toBe(true);
    expect(shouldPoll("reachable")).toBe(true);
    expect(shouldPoll("unreachable")).toBe(false);
  });

  it("路由上 unknown 按可达处理", () => {
    expect(isRoutable("unknown")).toBe(true);
    expect(isRoutable("reachable")).toBe(true);
    expect(isRoutable("unreachable")).toBe(false);
  });

  it("请求激活限频：同一上游一个探测间隔内最多一次", () => {
    expect(canActivate(INITIAL_HEALTH, 0)).toBe(true);
    const activated = markActivated(INITIAL_HEALTH, 1000);
    expect(canActivate(activated, 1000 + PROBE_INTERVAL_MS - 1)).toBe(false);
    expect(canActivate(activated, 1000 + PROBE_INTERVAL_MS)).toBe(true);
  });
});
