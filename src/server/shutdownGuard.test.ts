import { describe, expect, it } from "vitest";
import { createShutdownGuard, parseGraceMs, SHUTDOWN_GRACE_MS } from "./shutdownGuard";

/** 造一套可控的信号/定时器/退出替身，断言不依赖真实进程 */
function harness(graceMs?: number) {
  const handlers = new Map<string, () => void>();
  const timers: { fn: () => void; ms: number; unrefCalled: boolean }[] = [];
  const exits: number[] = [];
  const guard = createShutdownGuard({
    onSignal: (signal, handler) => handlers.set(signal, handler),
    setTimer: (fn, ms) => {
      const t = { fn, ms, unrefCalled: false };
      timers.push(t);
      return {
        unref() {
          t.unrefCalled = true;
        },
      };
    },
    exit: (code) => exits.push(code),
    ...(graceMs !== undefined ? { graceMs } : {}),
  });
  return { guard, handlers, timers, exits };
}

describe("createShutdownGuard", () => {
  it("install 注册 SIGTERM 与 SIGINT 两个监听器", () => {
    const h = harness();
    h.guard.install();
    expect([...h.handlers.keys()].sort()).toEqual(["SIGINT", "SIGTERM"]);
  });

  it("收到信号只起定时器，宽限期内不退出（把优雅收尾的时间让出去）", () => {
    const h = harness();
    h.guard.install();
    h.handlers.get("SIGTERM")!();
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0].ms).toBe(SHUTDOWN_GRACE_MS);
    expect(h.exits).toEqual([]);
  });

  it("宽限期到仍未退出 → SIGTERM 强制退出码 143", () => {
    const h = harness();
    h.guard.install();
    h.handlers.get("SIGTERM")!();
    h.timers[0].fn();
    expect(h.exits).toEqual([143]);
  });

  it("SIGINT 强制退出码 130（与 Next 自身 cleanup 的码一致）", () => {
    const h = harness();
    h.guard.install();
    h.handlers.get("SIGINT")!();
    h.timers[0].fn();
    expect(h.exits).toEqual([130]);
  });

  it("兜底定时器必须 unref：它自己不该成为进程退不出的新理由", () => {
    const h = harness();
    h.guard.install();
    h.handlers.get("SIGTERM")!();
    expect(h.timers[0].unrefCalled).toBe(true);
  });

  it("install 幂等：重复调用不叠加监听器", () => {
    const handlers: string[] = [];
    const guard = createShutdownGuard({
      onSignal: (signal) => handlers.push(signal),
      setTimer: () => ({ unref() {} }),
      exit: () => {},
    });
    guard.install();
    guard.install();
    guard.install();
    expect(handlers).toEqual(["SIGTERM", "SIGINT"]);
  });

  it("同一次关机内信号重复到达不叠加定时器（docker stop 后用户又按 Ctrl-C）", () => {
    const h = harness();
    h.guard.install();
    h.handlers.get("SIGTERM")!();
    h.handlers.get("SIGTERM")!();
    h.handlers.get("SIGINT")!();
    expect(h.timers).toHaveLength(1);
  });

  it("首个信号决定退出码：后到的信号不改写已定的码", () => {
    const h = harness();
    h.guard.install();
    h.handlers.get("SIGINT")!();
    h.handlers.get("SIGTERM")!();
    h.timers[0].fn();
    expect(h.exits).toEqual([130]);
  });

  it("宽限期可注入（测试与将来调参用）", () => {
    const h = harness(500);
    h.guard.install();
    h.handlers.get("SIGTERM")!();
    expect(h.timers[0].ms).toBe(500);
  });
});

describe("parseGraceMs", () => {
  it("未设置 → null（回落默认）", () => {
    expect(parseGraceMs(undefined)).toBeNull();
  });
  it("合法正数 → 采用", () => {
    expect(parseGraceMs("6000")).toBe(6000);
  });
  it("非数字 → null 而非 NaN（配置写错不该让关机路径失效）", () => {
    expect(parseGraceMs("abc")).toBeNull();
  });
  it("零与负数 → null（0 会让兜底立刻开火，等于绕过优雅收尾）", () => {
    expect(parseGraceMs("0")).toBeNull();
    expect(parseGraceMs("-1")).toBeNull();
  });
});
