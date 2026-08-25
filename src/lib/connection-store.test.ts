import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CONNECTION_FAILURE_THRESHOLD,
  connectionStore,
  resetConnectionStoreForTest,
} from "./connection-store";

describe("connection-store（UX P0 Task 2/3）", () => {
  afterEach(() => {
    resetConnectionStoreForTest();
  });

  it(`网络失败累计 ${CONNECTION_FAILURE_THRESHOLD} 次才判离线（单次抖动不误报）`, () => {
    connectionStore.reportRequestFailure();
    expect(connectionStore.getSnapshot()).toBe("online");
    connectionStore.reportRequestFailure();
    expect(connectionStore.getSnapshot()).toBe("offline");
  });

  it("成功往返清零计数并从离线恢复", () => {
    connectionStore.reportRequestFailure();
    connectionStore.reportRequestFailure();
    expect(connectionStore.getSnapshot()).toBe("offline");
    connectionStore.reportRequestSuccess();
    expect(connectionStore.getSnapshot()).toBe("online");
    // 恢复后单次失败仍是 online（计数已清零）
    connectionStore.reportRequestFailure();
    expect(connectionStore.getSnapshot()).toBe("online");
  });

  it("浏览器 offline 事件即时判离线（不经阈值）", () => {
    connectionStore.reportBrowserOffline();
    expect(connectionStore.getSnapshot()).toBe("offline");
  });

  it("subscribe 通知状态变更并支持退订", () => {
    const listener = vi.fn();
    const unsubscribe = connectionStore.subscribe(listener);
    connectionStore.reportRequestFailure();
    expect(listener).not.toHaveBeenCalled();
    connectionStore.reportRequestFailure();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    connectionStore.reportRequestSuccess();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("SSR 快照恒 online", () => {
    connectionStore.reportBrowserOffline();
    expect(connectionStore.getServerSnapshot()).toBe("online");
  });
});
