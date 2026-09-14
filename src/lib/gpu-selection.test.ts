import { describe, expect, it } from "vitest";
import { isAscendingDeviceList, parseSelectedDevices, toggleSelectedDevice } from "./gpu-selection";

describe("parseSelectedDevices", () => {
  it("宽容解析：忽略解析不出的项，保留能解析成非负整数的项", () => {
    expect(parseSelectedDevices("0,x")).toEqual([0]);
  });
  it("空项被忽略", () => {
    expect(parseSelectedDevices("0,,2")).toEqual([0, 2]);
  });
  it("去重并升序返回", () => {
    expect(parseSelectedDevices("2,0,2")).toEqual([0, 2]);
  });
  it("空串 → 空数组", () => {
    expect(parseSelectedDevices("")).toEqual([]);
  });
  it("全部非法 → 空数组", () => {
    expect(parseSelectedDevices("abc")).toEqual([]);
  });
  it("负数不是合法卡号，被忽略", () => {
    expect(parseSelectedDevices("-1")).toEqual([]);
    expect(parseSelectedDevices("-1,0")).toEqual([0]);
  });
  it("容忍逗号周围空格", () => {
    expect(parseSelectedDevices("0, 2")).toEqual([0, 2]);
  });
});

describe("toggleSelectedDevice", () => {
  it("勾选一张新卡 → 加入并保持升序", () => {
    expect(toggleSelectedDevice("0", 1, true)).toBe("0,1");
    expect(toggleSelectedDevice("1", 0, true)).toBe("0,1");
  });
  it("on: true 且已存在 → 结果不变（幂等）", () => {
    expect(toggleSelectedDevice("0,1", 1, true)).toBe("0,1");
  });
  it("on: false 且不存在 → 结果不变（幂等）", () => {
    expect(toggleSelectedDevice("0,1", 2, false)).toBe("0,1");
  });
  it("取消勾选存在的卡 → 从列表中移除", () => {
    expect(toggleSelectedDevice("0,1", 0, false)).toBe("1");
  });
  it("删到空 → 返回空串（上层据此报「至少选一张卡」）", () => {
    expect(toggleSelectedDevice("0", 0, false)).toBe("");
  });
  it('走宽容解析：raw 里的非法项在 toggle 后被丢弃（"0,x" 上勾 GPU2 → "0,2"）', () => {
    expect(toggleSelectedDevice("0,x", 2, true)).toBe("0,2");
  });
  it("手写顺序不影响结果：toggle 恒产出升序", () => {
    expect(toggleSelectedDevice("2,0", 3, true)).toBe("0,2,3");
  });
});

describe("isAscendingDeviceList", () => {
  it("单项 → true", () => {
    expect(isAscendingDeviceList("0")).toBe(true);
  });
  it("严格升序 → true", () => {
    expect(isAscendingDeviceList("0,2")).toBe(true);
  });
  it("非升序 → false", () => {
    expect(isAscendingDeviceList("2,0")).toBe(false);
  });
  it("相等项不算严格升序 → false", () => {
    expect(isAscendingDeviceList("1,1")).toBe(false);
  });
  it("解析不出（无顺序概念）→ true，不额外报警", () => {
    expect(isAscendingDeviceList("")).toBe(true);
    expect(isAscendingDeviceList("abc")).toBe(true);
    expect(isAscendingDeviceList("0,x")).toBe(true);
  });
});
