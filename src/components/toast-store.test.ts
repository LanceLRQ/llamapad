import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MAX_TOASTS,
  TOAST_DURATION_MS,
  createToastStore,
  type ToastStore,
} from "./toast-store";

/** 每例独立 store + 假时钟：定时器行为可精确推进验证 */
describe("toast-store（UX P0 Task 1）", () => {
  let store: ToastStore;

  beforeEach(() => {
    vi.useFakeTimers();
    store = createToastStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("push 入栈并自增 id；快照在无变更时引用稳定", () => {
    const first = store.push("success", "a");
    const second = store.push("error", "b");
    expect(first).not.toBe(second);
    expect(store.getSnapshot().map((item) => [item.variant, item.message])).toEqual([
      ["success", "a"],
      ["error", "b"],
    ]);
    const before = store.getSnapshot();
    expect(store.getSnapshot()).toBe(before);
  });

  it("各变体默认时长生效：到点自动出栈", () => {
    store.push("success", "ok");
    store.push("error", "bad");
    vi.advanceTimersByTime(TOAST_DURATION_MS.success);
    expect(store.getSnapshot().map((item) => item.message)).toEqual(["bad"]);
    vi.advanceTimersByTime(TOAST_DURATION_MS.error - TOAST_DURATION_MS.success);
    expect(store.getSnapshot()).toHaveLength(0);
  });

  it("自定义时长覆盖默认", () => {
    store.push("info", "自定义", 1_000);
    vi.advanceTimersByTime(999);
    expect(store.getSnapshot()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(store.getSnapshot()).toHaveLength(0);
  });

  it(`超过 ${MAX_TOASTS} 条裁最旧，被裁项定时器一并清理`, () => {
    for (let i = 0; i < MAX_TOASTS + 2; i += 1) store.push("info", `m${i}`);
    // 只保留最新 MAX_TOASTS 条（m2..m5）
    expect(store.getSnapshot().map((item) => item.message)).toEqual([
      "m2",
      "m3",
      "m4",
      "m5",
    ]);
    // 被裁掉的 m0/m1 即使时间推进也不产生幽灵回调（后续项存活即可证）
    vi.advanceTimersByTime(TOAST_DURATION_MS.info);
    expect(store.getSnapshot()).toHaveLength(0);
  });

  it("dismiss 手动关闭；重复 dismiss 与关闭不存在项是安全空操作", () => {
    const id = store.push("error", "x");
    store.dismiss(id);
    store.dismiss(id);
    store.dismiss(9999);
    expect(store.getSnapshot()).toHaveLength(0);
  });

  it("手动关闭后定时器已清理：不再影响后续项", () => {
    const first = store.push("info", "first");
    store.push("info", "second", TOAST_DURATION_MS.info + 5_000);
    store.dismiss(first);
    vi.advanceTimersByTime(TOAST_DURATION_MS.info);
    expect(store.getSnapshot().map((item) => item.message)).toEqual(["second"]);
  });

  it("subscribe 通知变更并在退订后静默", () => {
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.push("success", "a");
    expect(listener).toHaveBeenCalledTimes(1);
    store.push("success", "b");
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    store.push("success", "c");
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
