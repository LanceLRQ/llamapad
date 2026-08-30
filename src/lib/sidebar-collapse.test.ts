import { describe, expect, it } from "vitest";

import {
  SIDEBAR_ATTR,
  SIDEBAR_COLLAPSED_VALUE,
  SIDEBAR_INIT_SCRIPT,
  SIDEBAR_STORAGE_KEY,
} from "./sidebar-collapse";

/**
 * 侧栏折叠态纯逻辑测试。vitest 是 environment: "node"，没有 jsdom，
 * sidebarCollapseStore 碰 document/localStorage 的部分测不了，不测；
 * 只测 SIDEBAR_INIT_SCRIPT 这一块纯逻辑——直接在假的 localStorage / document 上
 * 执行这段字符串本身，而不是给它写一份平行的 TS 判定函数（那样改坏脚本，
 * 平行副本的测试照样全绿，等于没测）。
 */

/** 在假的 localStorage / document 上跑一遍真正的内联脚本，返回它给 <html> 打上的属性值
 *  （没打上则为 null）。测脚本本身而不是它的平行副本——生产里跑的就是这个字符串 */
function runInitScript(stored: string | null | (() => never)): string | null {
  let attr: string | null = null;
  const documentStub = {
    documentElement: {
      setAttribute(name: string, value: string) {
        if (name === SIDEBAR_ATTR) attr = value;
      },
    },
  };
  const storageStub = {
    getItem: () => (typeof stored === "function" ? stored() : stored),
  };
  new Function("localStorage", "document", SIDEBAR_INIT_SCRIPT)(storageStub, documentStub);
  return attr;
}

describe("SIDEBAR_INIT_SCRIPT（首屏内联脚本，防与常量漂移）", () => {
  it("同时包含 SIDEBAR_STORAGE_KEY、SIDEBAR_COLLAPSED_VALUE、SIDEBAR_ATTR 三个常量", () => {
    expect(SIDEBAR_INIT_SCRIPT).toContain(SIDEBAR_STORAGE_KEY);
    expect(SIDEBAR_INIT_SCRIPT).toContain(SIDEBAR_COLLAPSED_VALUE);
    expect(SIDEBAR_INIT_SCRIPT).toContain(SIDEBAR_ATTR);
  });

  it("是合法 JS（new Function 只解析不执行，node 缺 document/localStorage 也不会炸）", () => {
    expect(() => new Function(SIDEBAR_INIT_SCRIPT)).not.toThrow();
  });
});

describe("SIDEBAR_INIT_SCRIPT 实跑（在假 localStorage / document 上执行这段脚本本身）", () => {
  it("存了 SIDEBAR_COLLAPSED_VALUE：属性被打成 SIDEBAR_COLLAPSED_VALUE", () => {
    expect(runInitScript(SIDEBAR_COLLAPSED_VALUE)).toBe(SIDEBAR_COLLAPSED_VALUE);
  });

  it("null（从未存过）：不打属性", () => {
    expect(runInitScript(null)).toBeNull();
  });

  it("空串：不打属性", () => {
    expect(runInitScript("")).toBeNull();
  });

  it("\"expanded\"：不打属性", () => {
    expect(runInitScript("expanded")).toBeNull();
  });

  it("大小写不同的脏数据（如 \"COLLAPSED\"）：不打属性，只认精确值", () => {
    expect(runInitScript("COLLAPSED")).toBeNull();
  });

  it("localStorage 读取抛异常时脚本自身不抛（隐私模式 / 存储被禁）：脚本在 body 顶部同步执行，抛出会打断后面整棵树的渲染", () => {
    expect(() =>
      runInitScript(() => {
        throw new Error("SecurityError");
      }),
    ).not.toThrow();
  });
});
