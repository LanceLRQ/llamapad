import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_REFRESH_INTERVAL_MS,
  REFRESH_INTERVAL_OPTIONS,
  REFRESH_INTERVAL_STORAGE_KEY,
  readRefreshInterval,
  refreshIntervalStore,
  resetRefreshIntervalStoreForTest,
  writeRefreshInterval,
} from "./refresh-interval";

/** 造一个最小可用的 localStorage 假实现，按需覆写单个方法制造异常 */
function fakeStorage(overrides: Partial<Storage> = {}): Storage {
  const backing = new Map<string, string>();
  return {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => {
      backing.set(key, value);
    },
    removeItem: (key: string) => backing.delete(key),
    clear: () => backing.clear(),
    key: () => null,
    get length() {
      return backing.size;
    },
    ...overrides,
  } as Storage;
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetRefreshIntervalStoreForTest();
});

describe("档位常量", () => {
  it("五档从 1s 到 30s，默认 5s", () => {
    expect(REFRESH_INTERVAL_OPTIONS).toEqual([1000, 2000, 5000, 10000, 30000]);
    expect(DEFAULT_REFRESH_INTERVAL_MS).toBe(5000);
  });
});

describe("readRefreshInterval（吃掉一切脏数据，绝不抛错）", () => {
  it("SSR 环境（无 window）回落默认值", () => {
    expect(readRefreshInterval()).toBe(DEFAULT_REFRESH_INTERVAL_MS);
  });

  it("键不存在时回落默认值", () => {
    vi.stubGlobal("window", { localStorage: fakeStorage() });
    expect(readRefreshInterval()).toBe(DEFAULT_REFRESH_INTERVAL_MS);
  });

  it("非数字字符串（被手改成 \"abc\"）回落默认值", () => {
    const storage = fakeStorage();
    storage.setItem(REFRESH_INTERVAL_STORAGE_KEY, "abc");
    vi.stubGlobal("window", { localStorage: storage });
    expect(readRefreshInterval()).toBe(DEFAULT_REFRESH_INTERVAL_MS);
  });

  it("数字但不在档位表里（如 3000）回落默认值", () => {
    const storage = fakeStorage();
    storage.setItem(REFRESH_INTERVAL_STORAGE_KEY, "3000");
    vi.stubGlobal("window", { localStorage: storage });
    expect(readRefreshInterval()).toBe(DEFAULT_REFRESH_INTERVAL_MS);
  });

  it("非有限数（Infinity/NaN）回落默认值", () => {
    const storage = fakeStorage();
    storage.setItem(REFRESH_INTERVAL_STORAGE_KEY, "Infinity");
    vi.stubGlobal("window", { localStorage: storage });
    expect(readRefreshInterval()).toBe(DEFAULT_REFRESH_INTERVAL_MS);
  });

  it("合法档位值原样读出", () => {
    const storage = fakeStorage();
    storage.setItem(REFRESH_INTERVAL_STORAGE_KEY, "10000");
    vi.stubGlobal("window", { localStorage: storage });
    expect(readRefreshInterval()).toBe(10000);
  });

  it("localStorage.getItem 抛错（隐私模式/被禁用）回落默认值而非抛出", () => {
    const storage = fakeStorage({
      getItem: () => {
        throw new Error("SecurityError");
      },
    });
    vi.stubGlobal("window", { localStorage: storage });
    expect(readRefreshInterval()).toBe(DEFAULT_REFRESH_INTERVAL_MS);
  });

  it("访问 window.localStorage 本身抛错时回落默认值而非抛出", () => {
    vi.stubGlobal("window", {
      get localStorage(): Storage {
        throw new Error("SecurityError");
      },
    });
    expect(readRefreshInterval()).toBe(DEFAULT_REFRESH_INTERVAL_MS);
  });
});

describe("writeRefreshInterval（写失败静默）", () => {
  it("正常写入调用 setItem 且值序列化为字符串", () => {
    const storage = fakeStorage();
    const setItem = vi.spyOn(storage, "setItem");
    vi.stubGlobal("window", { localStorage: storage });
    writeRefreshInterval(2000);
    expect(setItem).toHaveBeenCalledWith(REFRESH_INTERVAL_STORAGE_KEY, "2000");
  });

  it("SSR 环境（无 window）不抛错", () => {
    expect(() => writeRefreshInterval(1000)).not.toThrow();
  });

  it("setItem 抛错（隐私模式/配额）静默吞掉不抛出", () => {
    const storage = fakeStorage({
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    });
    vi.stubGlobal("window", { localStorage: storage });
    expect(() => writeRefreshInterval(1000)).not.toThrow();
  });
});

describe("refreshIntervalStore（跨组件同步用的模块级订阅）", () => {
  it("hydrate 前 getSnapshot 恒为默认值（首屏不读 localStorage）", () => {
    const storage = fakeStorage();
    storage.setItem(REFRESH_INTERVAL_STORAGE_KEY, "30000");
    vi.stubGlobal("window", { localStorage: storage });
    expect(refreshIntervalStore.getSnapshot()).toBe(DEFAULT_REFRESH_INTERVAL_MS);
  });

  it("getServerSnapshot 恒为默认值（不受内存态影响）", () => {
    const storage = fakeStorage();
    vi.stubGlobal("window", { localStorage: storage });
    refreshIntervalStore.setValue(30000);
    expect(refreshIntervalStore.getServerSnapshot()).toBe(DEFAULT_REFRESH_INTERVAL_MS);
  });

  it("hydrate 从 localStorage 读真实值并通知订阅者", () => {
    const storage = fakeStorage();
    storage.setItem(REFRESH_INTERVAL_STORAGE_KEY, "10000");
    vi.stubGlobal("window", { localStorage: storage });
    const listener = vi.fn();
    refreshIntervalStore.subscribe(listener);

    refreshIntervalStore.hydrate();

    expect(refreshIntervalStore.getSnapshot()).toBe(10000);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("hydrate 幂等：多次调用（多个组件同时挂载）只真正生效一次", () => {
    const storage = fakeStorage();
    storage.setItem(REFRESH_INTERVAL_STORAGE_KEY, "10000");
    vi.stubGlobal("window", { localStorage: storage });
    const listener = vi.fn();
    refreshIntervalStore.subscribe(listener);

    refreshIntervalStore.hydrate();
    refreshIntervalStore.hydrate();
    refreshIntervalStore.hydrate();

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("hydrate 读到的值恰好等于当前内存态时不多余通知", () => {
    vi.stubGlobal("window", { localStorage: fakeStorage() }); // 空存储 → 读出即默认值
    const listener = vi.fn();
    refreshIntervalStore.subscribe(listener);

    refreshIntervalStore.hydrate();

    expect(listener).not.toHaveBeenCalled();
  });

  it("setValue 更新内存态、持久化并通知订阅者", () => {
    const storage = fakeStorage();
    vi.stubGlobal("window", { localStorage: storage });
    const listener = vi.fn();
    refreshIntervalStore.subscribe(listener);

    refreshIntervalStore.setValue(1000);

    expect(refreshIntervalStore.getSnapshot()).toBe(1000);
    expect(storage.getItem(REFRESH_INTERVAL_STORAGE_KEY)).toBe("1000");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("setValue 传入与当前相同的值不重复通知（监控页/概览页各自触发一次选择不应互相抖动）", () => {
    vi.stubGlobal("window", { localStorage: fakeStorage() });
    refreshIntervalStore.setValue(2000);
    const listener = vi.fn();
    refreshIntervalStore.subscribe(listener);

    refreshIntervalStore.setValue(2000);

    expect(listener).not.toHaveBeenCalled();
  });

  it("subscribe 返回的退订函数生效后不再收到通知", () => {
    vi.stubGlobal("window", { localStorage: fakeStorage() });
    const listener = vi.fn();
    const unsubscribe = refreshIntervalStore.subscribe(listener);
    unsubscribe();

    refreshIntervalStore.setValue(30000);

    expect(listener).not.toHaveBeenCalled();
  });

  it("两个订阅者（模拟监控页 + 概览页两处选择器）同时收到同一次变更通知", () => {
    vi.stubGlobal("window", { localStorage: fakeStorage() });
    const monitoringPageListener = vi.fn();
    const overviewPageListener = vi.fn();
    refreshIntervalStore.subscribe(monitoringPageListener);
    refreshIntervalStore.subscribe(overviewPageListener);

    refreshIntervalStore.setValue(1000);

    expect(monitoringPageListener).toHaveBeenCalledTimes(1);
    expect(overviewPageListener).toHaveBeenCalledTimes(1);
    expect(refreshIntervalStore.getSnapshot()).toBe(1000);
  });
});
