import { describe, expect, it } from "vitest";

import { computeChipCounts } from "./toolbar-counts";

interface Item {
  status: "running" | "stopped";
  name: string;
}

const CHIPS = [
  { key: "all", match: () => true },
  { key: "running", match: (i: Item) => i.status === "running" },
  { key: "stopped", match: (i: Item) => i.status === "stopped" },
];

function items(): Item[] {
  return [
    { status: "running", name: "qwen2.5-7b" },
    { status: "running", name: "llama3-8b" },
    { status: "stopped", name: "phi3-mini" },
    { status: "stopped", name: "gemma2-9b" },
    { status: "stopped", name: "mistral-7b" },
  ];
}

describe("computeChipCounts（Toolbar 筛选 chip 计数）", () => {
  it("无搜索时各 chip 计数 = 各自 match 在全量 items 上的命中数", () => {
    expect(computeChipCounts(items(), CHIPS)).toEqual({ all: 5, running: 2, stopped: 3 });
  });

  it("有搜索词时计数在 searchMatch 收窄后的结果内重算", () => {
    // 搜索 "7b"：命中 qwen2.5-7b（running）与 mistral-7b（stopped）
    const searchMatch = (i: Item) => i.name.includes("7b");
    expect(computeChipCounts(items(), CHIPS, searchMatch)).toEqual({
      all: 2,
      running: 1,
      stopped: 1,
    });
  });

  it("选中不影响其余 chip 的计数：签名不收 activeChip，误传预过滤列表才会出错", () => {
    // 本函数签名根本不收 activeChip，"选中态无从影响计数"这条规则由类型签名
    // 本身保证，不需要靠调用两次同样的输入去验证一个纯函数的确定性（那种断言
    // 在任何实现下都会通过，测不出问题）。真正有意义的是反证下面这种典型误用：
    const all = items();

    // 正确用法：全量 items 直接算，stopped 命中 3 条
    expect(computeChipCounts(all, CHIPS).stopped).toBe(3);

    // 反证错误用法：如果调用方误把"选中 running 后的可见列表"当成 items 传入，
    // stopped 的计数会被焊死成 0——这正是本函数的 docstring 要防的坑，
    // 也是"计数不参与自身筛选"这条规则存在的理由
    const wronglyPreFiltered = all.filter((i) => i.status === "running");
    const wrongCounts = computeChipCounts(wronglyPreFiltered, CHIPS);
    expect(wrongCounts.stopped).toBe(0);
  });

  it("空列表时所有 chip 计数为 0", () => {
    expect(computeChipCounts([], CHIPS)).toEqual({ all: 0, running: 0, stopped: 0 });
  });

  it("一个 item 命中多个 chip（如“全部”与“运行中”）时各自都计数，不互斥", () => {
    const counts = computeChipCounts(items(), CHIPS);
    // running 的 2 条同时也被 "all" 计入，两者不是互斥关系
    expect(counts.all).toBeGreaterThanOrEqual(counts.running);
    expect(counts.all).toBe(5);
    expect(counts.running).toBe(2);
  });
});
