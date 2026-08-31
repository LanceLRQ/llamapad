import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_MODEL_SORT,
  MODEL_SORT_STORAGE_KEY,
  compareModels,
  modelSortLabelKey,
  modelSortStore,
  nextNameSort,
  parseModelSort,
  readModelSort,
  resetModelSortStoreForTest,
  serializeModelSort,
  writeModelSort,
} from "./models-sort";

/** 造一个最小可用的 localStorage 假实现，按需覆写单个方法制造异常
 *  （与 refresh-interval.test.ts 同款假实现，两处各自独立一份，
 *  避免测试文件之间产生隐式依赖） */
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
  resetModelSortStoreForTest();
});

describe("compareModels", () => {
  const a = { name: "beta", createdAt: "2026-01-01T00:00:00.000Z" };
  const b = { name: "alpha", createdAt: "2026-01-02T00:00:00.000Z" };

  it("name 升序：localeCompare 的稳定口径", () => {
    expect(compareModels(a, b, { key: "name", dir: "asc" })).toBeGreaterThan(0);
    expect(compareModels(b, a, { key: "name", dir: "asc" })).toBeLessThan(0);
  });

  it("name 降序：与升序结果相反", () => {
    expect(compareModels(a, b, { key: "name", dir: "desc" })).toBeLessThan(0);
    expect(compareModels(b, a, { key: "name", dir: "desc" })).toBeGreaterThan(0);
  });

  it("created 升序：早创建的排前面", () => {
    // a 是 01-01（更早），b 是 01-02（更晚）
    expect(compareModels(a, b, { key: "created", dir: "asc" })).toBeLessThan(0);
  });

  it("created 降序：晚创建的排前面", () => {
    expect(compareModels(a, b, { key: "created", dir: "desc" })).toBeGreaterThan(0);
  });

  it("created 相同时间戳：用名称升序兜底，且不受 dir 影响（否则两次渲染顺序不稳定）", () => {
    const sameTimeA = { name: "zebra", createdAt: "2026-01-01T00:00:00.000Z" };
    const sameTimeB = { name: "apple", createdAt: "2026-01-01T00:00:00.000Z" };

    // asc：兜底仍是名称升序 → apple 在前
    expect(compareModels(sameTimeA, sameTimeB, { key: "created", dir: "asc" })).toBeGreaterThan(0);
    // desc：主键打平后兜底同样是名称升序，不因 desc 反向
    expect(compareModels(sameTimeA, sameTimeB, { key: "created", dir: "desc" })).toBeGreaterThan(
      0,
    );
  });
});

describe("nextNameSort（表头点击排序的下一状态；只负责名称这一维）", () => {
  it("当前按创建时间升序 → 切到名称升序（表头点击不改变时间维度的选择）", () => {
    expect(nextNameSort({ key: "created", dir: "asc" })).toEqual({ key: "name", dir: "asc" });
  });

  it("当前按创建时间降序 → 同样先落到名称升序", () => {
    expect(nextNameSort({ key: "created", dir: "desc" })).toEqual({ key: "name", dir: "asc" });
  });

  it("当前名称升序 → 切到名称降序", () => {
    expect(nextNameSort({ key: "name", dir: "asc" })).toEqual({ key: "name", dir: "desc" });
  });

  it("当前名称降序 → 切回名称升序", () => {
    expect(nextNameSort({ key: "name", dir: "desc" })).toEqual({ key: "name", dir: "asc" });
  });
});

describe("parseModelSort（脏数据一律回落默认）", () => {
  it("null 回落默认", () => {
    expect(parseModelSort(null)).toEqual(DEFAULT_MODEL_SORT);
  });

  it("空串回落默认", () => {
    expect(parseModelSort("")).toEqual(DEFAULT_MODEL_SORT);
  });

  it("乱码回落默认", () => {
    expect(parseModelSort("asdf:zxcv")).toEqual(DEFAULT_MODEL_SORT);
  });

  it("只有一半（缺方向）回落默认", () => {
    expect(parseModelSort("created")).toEqual(DEFAULT_MODEL_SORT);
  });

  it("只有一半（缺键，只有冒号加方向）回落默认", () => {
    expect(parseModelSort(":asc")).toEqual(DEFAULT_MODEL_SORT);
  });

  it("键合法但方向非法回落默认", () => {
    expect(parseModelSort("name:sideways")).toEqual(DEFAULT_MODEL_SORT);
  });

  it("合法值原样解析：name:desc", () => {
    expect(parseModelSort("name:desc")).toEqual({ key: "name", dir: "desc" });
  });

  it("合法值原样解析：created:asc", () => {
    expect(parseModelSort("created:asc")).toEqual({ key: "created", dir: "asc" });
  });
});

describe("serializeModelSort 与 parseModelSort 互为逆运算", () => {
  it("默认值序列化后能解析回原值", () => {
    expect(parseModelSort(serializeModelSort(DEFAULT_MODEL_SORT))).toEqual(DEFAULT_MODEL_SORT);
  });

  it("四种组合都能往返", () => {
    const combos = [
      { key: "name", dir: "asc" },
      { key: "name", dir: "desc" },
      { key: "created", dir: "asc" },
      { key: "created", dir: "desc" },
    ] as const;
    for (const sort of combos) {
      expect(parseModelSort(serializeModelSort(sort))).toEqual(sort);
    }
  });
});

describe("modelSortLabelKey：四种组合各对应哪个 i18n key（触发器与选项共用同一份映射，别各写一遍）", () => {
  it("name:asc → sortNameAsc", () => {
    expect(modelSortLabelKey({ key: "name", dir: "asc" })).toBe("sortNameAsc");
  });

  it("name:desc → sortNameDesc", () => {
    expect(modelSortLabelKey({ key: "name", dir: "desc" })).toBe("sortNameDesc");
  });

  it("created:asc → sortCreatedAsc", () => {
    expect(modelSortLabelKey({ key: "created", dir: "asc" })).toBe("sortCreatedAsc");
  });

  it("created:desc → sortCreatedDesc", () => {
    expect(modelSortLabelKey({ key: "created", dir: "desc" })).toBe("sortCreatedDesc");
  });
});

describe("readModelSort（吃掉一切脏数据，绝不抛错）", () => {
  it("SSR 环境（无 window）回落默认值", () => {
    expect(readModelSort()).toEqual(DEFAULT_MODEL_SORT);
  });

  it("键不存在时回落默认值", () => {
    vi.stubGlobal("window", { localStorage: fakeStorage() });
    expect(readModelSort()).toEqual(DEFAULT_MODEL_SORT);
  });

  it("被手改成乱码时回落默认值", () => {
    const storage = fakeStorage();
    storage.setItem(MODEL_SORT_STORAGE_KEY, "garbage");
    vi.stubGlobal("window", { localStorage: storage });
    expect(readModelSort()).toEqual(DEFAULT_MODEL_SORT);
  });

  it("合法值原样读出", () => {
    const storage = fakeStorage();
    storage.setItem(MODEL_SORT_STORAGE_KEY, "created:desc");
    vi.stubGlobal("window", { localStorage: storage });
    expect(readModelSort()).toEqual({ key: "created", dir: "desc" });
  });

  it("localStorage.getItem 抛错（隐私模式/被禁用）回落默认值而非抛出", () => {
    const storage = fakeStorage({
      getItem: () => {
        throw new Error("SecurityError");
      },
    });
    vi.stubGlobal("window", { localStorage: storage });
    expect(readModelSort()).toEqual(DEFAULT_MODEL_SORT);
  });

  it("访问 window.localStorage 本身抛错时回落默认值而非抛出", () => {
    vi.stubGlobal("window", {
      get localStorage(): Storage {
        throw new Error("SecurityError");
      },
    });
    expect(readModelSort()).toEqual(DEFAULT_MODEL_SORT);
  });
});

describe("writeModelSort（写失败静默）", () => {
  it("正常写入调用 setItem 且序列化为 key:dir 字符串", () => {
    const storage = fakeStorage();
    const setItem = vi.spyOn(storage, "setItem");
    vi.stubGlobal("window", { localStorage: storage });
    writeModelSort({ key: "created", dir: "asc" });
    expect(setItem).toHaveBeenCalledWith(MODEL_SORT_STORAGE_KEY, "created:asc");
  });

  it("SSR 环境（无 window）不抛错", () => {
    expect(() => writeModelSort(DEFAULT_MODEL_SORT)).not.toThrow();
  });

  it("setItem 抛错（隐私模式/配额）静默吞掉不抛出", () => {
    const storage = fakeStorage({
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    });
    vi.stubGlobal("window", { localStorage: storage });
    expect(() => writeModelSort(DEFAULT_MODEL_SORT)).not.toThrow();
  });
});

describe("modelSortStore（供 useSyncExternalStore 消费，避开 useEffect 里直接 setState）", () => {
  it("hydrate 前 getSnapshot 恒为默认值（首屏不读 localStorage）", () => {
    const storage = fakeStorage();
    storage.setItem(MODEL_SORT_STORAGE_KEY, "created:desc");
    vi.stubGlobal("window", { localStorage: storage });
    expect(modelSortStore.getSnapshot()).toEqual(DEFAULT_MODEL_SORT);
  });

  it("getServerSnapshot 恒为默认值（不受内存态影响）", () => {
    vi.stubGlobal("window", { localStorage: fakeStorage() });
    modelSortStore.setValue({ key: "created", dir: "desc" });
    expect(modelSortStore.getServerSnapshot()).toEqual(DEFAULT_MODEL_SORT);
  });

  it("hydrate 从 localStorage 读真实值并通知订阅者", () => {
    const storage = fakeStorage();
    storage.setItem(MODEL_SORT_STORAGE_KEY, "created:desc");
    vi.stubGlobal("window", { localStorage: storage });
    const listener = vi.fn();
    modelSortStore.subscribe(listener);

    modelSortStore.hydrate();

    expect(modelSortStore.getSnapshot()).toEqual({ key: "created", dir: "desc" });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("hydrate 幂等：多次调用只真正生效一次", () => {
    const storage = fakeStorage();
    storage.setItem(MODEL_SORT_STORAGE_KEY, "created:desc");
    vi.stubGlobal("window", { localStorage: storage });
    const listener = vi.fn();
    modelSortStore.subscribe(listener);

    modelSortStore.hydrate();
    modelSortStore.hydrate();
    modelSortStore.hydrate();

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("hydrate 读到的值恰好等于当前内存态时不多余通知", () => {
    vi.stubGlobal("window", { localStorage: fakeStorage() }); // 空存储 → 读出即默认值
    const listener = vi.fn();
    modelSortStore.subscribe(listener);

    modelSortStore.hydrate();

    expect(listener).not.toHaveBeenCalled();
  });

  it("setValue 更新内存态、持久化并通知订阅者", () => {
    const storage = fakeStorage();
    vi.stubGlobal("window", { localStorage: storage });
    const listener = vi.fn();
    modelSortStore.subscribe(listener);

    modelSortStore.setValue({ key: "created", dir: "asc" });

    expect(modelSortStore.getSnapshot()).toEqual({ key: "created", dir: "asc" });
    expect(storage.getItem(MODEL_SORT_STORAGE_KEY)).toBe("created:asc");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("setValue 传入与当前相同的值不重复通知", () => {
    vi.stubGlobal("window", { localStorage: fakeStorage() });
    modelSortStore.setValue({ key: "name", dir: "desc" });
    const listener = vi.fn();
    modelSortStore.subscribe(listener);

    modelSortStore.setValue({ key: "name", dir: "desc" });

    expect(listener).not.toHaveBeenCalled();
  });

  it("subscribe 返回的退订函数生效后不再收到通知", () => {
    vi.stubGlobal("window", { localStorage: fakeStorage() });
    const listener = vi.fn();
    const unsubscribe = modelSortStore.subscribe(listener);
    unsubscribe();

    modelSortStore.setValue({ key: "created", dir: "desc" });

    expect(listener).not.toHaveBeenCalled();
  });
});
