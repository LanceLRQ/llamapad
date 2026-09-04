import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_REPO_WEIGHTS_VIEW,
  REPO_WEIGHTS_VIEW_STORAGE_KEY,
  parseRepoWeightsView,
  readRepoWeightsView,
  repoWeightsViewStore,
  resetRepoWeightsViewStoreForTest,
  writeRepoWeightsView,
} from "./repo-weights-view";

/** 造一个最小可用的 localStorage 假实现，按需覆写单个方法制造异常
 *  （与 models-sort.test.ts 同款假实现，两处各自独立一份，避免测试文件
 *  之间产生隐式依赖） */
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
  resetRepoWeightsViewStoreForTest();
});

describe("parseRepoWeightsView（脏数据一律回落默认）", () => {
  it("null 回落默认", () => {
    expect(parseRepoWeightsView(null)).toBe(DEFAULT_REPO_WEIGHTS_VIEW);
  });

  it("空串回落默认", () => {
    expect(parseRepoWeightsView("")).toBe(DEFAULT_REPO_WEIGHTS_VIEW);
  });

  it("乱码回落默认", () => {
    expect(parseRepoWeightsView("asdf")).toBe(DEFAULT_REPO_WEIGHTS_VIEW);
  });

  it("合法值原样解析：grouped", () => {
    expect(parseRepoWeightsView("grouped")).toBe("grouped");
  });

  it("合法值原样解析：flat", () => {
    expect(parseRepoWeightsView("flat")).toBe("flat");
  });
});

describe("readRepoWeightsView（吃掉一切脏数据，绝不抛错）", () => {
  it("SSR 环境（无 window）回落默认值", () => {
    expect(readRepoWeightsView()).toBe(DEFAULT_REPO_WEIGHTS_VIEW);
  });

  it("键不存在时回落默认值", () => {
    vi.stubGlobal("window", { localStorage: fakeStorage() });
    expect(readRepoWeightsView()).toBe(DEFAULT_REPO_WEIGHTS_VIEW);
  });

  it("被手改成乱码时回落默认值", () => {
    const storage = fakeStorage();
    storage.setItem(REPO_WEIGHTS_VIEW_STORAGE_KEY, "garbage");
    vi.stubGlobal("window", { localStorage: storage });
    expect(readRepoWeightsView()).toBe(DEFAULT_REPO_WEIGHTS_VIEW);
  });

  it("合法值原样读出", () => {
    const storage = fakeStorage();
    storage.setItem(REPO_WEIGHTS_VIEW_STORAGE_KEY, "flat");
    vi.stubGlobal("window", { localStorage: storage });
    expect(readRepoWeightsView()).toBe("flat");
  });

  it("localStorage.getItem 抛错（隐私模式/被禁用）回落默认值而非抛出", () => {
    const storage = fakeStorage({
      getItem: () => {
        throw new Error("SecurityError");
      },
    });
    vi.stubGlobal("window", { localStorage: storage });
    expect(readRepoWeightsView()).toBe(DEFAULT_REPO_WEIGHTS_VIEW);
  });

  it("访问 window.localStorage 本身抛错时回落默认值而非抛出", () => {
    vi.stubGlobal("window", {
      get localStorage(): Storage {
        throw new Error("SecurityError");
      },
    });
    expect(readRepoWeightsView()).toBe(DEFAULT_REPO_WEIGHTS_VIEW);
  });
});

describe("writeRepoWeightsView（写失败静默）", () => {
  it("正常写入调用 setItem 且值原样存入", () => {
    const storage = fakeStorage();
    const setItem = vi.spyOn(storage, "setItem");
    vi.stubGlobal("window", { localStorage: storage });
    writeRepoWeightsView("flat");
    expect(setItem).toHaveBeenCalledWith(REPO_WEIGHTS_VIEW_STORAGE_KEY, "flat");
  });

  it("SSR 环境（无 window）不抛错", () => {
    expect(() => writeRepoWeightsView(DEFAULT_REPO_WEIGHTS_VIEW)).not.toThrow();
  });

  it("setItem 抛错（隐私模式/配额）静默吞掉不抛出", () => {
    const storage = fakeStorage({
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    });
    vi.stubGlobal("window", { localStorage: storage });
    expect(() => writeRepoWeightsView(DEFAULT_REPO_WEIGHTS_VIEW)).not.toThrow();
  });
});

describe("repoWeightsViewStore（供 useSyncExternalStore 消费，避开 useEffect 里直接 setState）", () => {
  it("hydrate 前 getSnapshot 恒为默认值（首屏不读 localStorage）", () => {
    const storage = fakeStorage();
    storage.setItem(REPO_WEIGHTS_VIEW_STORAGE_KEY, "flat");
    vi.stubGlobal("window", { localStorage: storage });
    expect(repoWeightsViewStore.getSnapshot()).toBe(DEFAULT_REPO_WEIGHTS_VIEW);
  });

  it("getServerSnapshot 恒为默认值（不受内存态影响）", () => {
    vi.stubGlobal("window", { localStorage: fakeStorage() });
    repoWeightsViewStore.setValue("flat");
    expect(repoWeightsViewStore.getServerSnapshot()).toBe(DEFAULT_REPO_WEIGHTS_VIEW);
  });

  it("hydrate 从 localStorage 读真实值并通知订阅者", () => {
    const storage = fakeStorage();
    storage.setItem(REPO_WEIGHTS_VIEW_STORAGE_KEY, "flat");
    vi.stubGlobal("window", { localStorage: storage });
    const listener = vi.fn();
    repoWeightsViewStore.subscribe(listener);

    repoWeightsViewStore.hydrate();

    expect(repoWeightsViewStore.getSnapshot()).toBe("flat");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("hydrate 幂等：多次调用只真正生效一次", () => {
    const storage = fakeStorage();
    storage.setItem(REPO_WEIGHTS_VIEW_STORAGE_KEY, "flat");
    vi.stubGlobal("window", { localStorage: storage });
    const listener = vi.fn();
    repoWeightsViewStore.subscribe(listener);

    repoWeightsViewStore.hydrate();
    repoWeightsViewStore.hydrate();
    repoWeightsViewStore.hydrate();

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("hydrate 读到的值恰好等于当前内存态时不多余通知", () => {
    vi.stubGlobal("window", { localStorage: fakeStorage() }); // 空存储 → 读出即默认值
    const listener = vi.fn();
    repoWeightsViewStore.subscribe(listener);

    repoWeightsViewStore.hydrate();

    expect(listener).not.toHaveBeenCalled();
  });

  it("setValue 更新内存态、持久化并通知订阅者", () => {
    const storage = fakeStorage();
    vi.stubGlobal("window", { localStorage: storage });
    const listener = vi.fn();
    repoWeightsViewStore.subscribe(listener);

    repoWeightsViewStore.setValue("flat");

    expect(repoWeightsViewStore.getSnapshot()).toBe("flat");
    expect(storage.getItem(REPO_WEIGHTS_VIEW_STORAGE_KEY)).toBe("flat");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("setValue 传入与当前相同的值不重复通知", () => {
    vi.stubGlobal("window", { localStorage: fakeStorage() });
    const listener = vi.fn();
    repoWeightsViewStore.subscribe(listener);

    repoWeightsViewStore.setValue(DEFAULT_REPO_WEIGHTS_VIEW);

    expect(listener).not.toHaveBeenCalled();
  });

  it("subscribe 返回的退订函数生效后不再收到通知", () => {
    vi.stubGlobal("window", { localStorage: fakeStorage() });
    const listener = vi.fn();
    const unsubscribe = repoWeightsViewStore.subscribe(listener);
    unsubscribe();

    repoWeightsViewStore.setValue("flat");

    expect(listener).not.toHaveBeenCalled();
  });
});
