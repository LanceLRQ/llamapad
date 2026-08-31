import { describe, expect, it } from "vitest";

import type { PickerItem } from "./model-file-picker";
import { applyAutofill, computeAutofill, computeInitialAutofill, pickSiblingMmproj, suggestNamesFromFile } from "./wizard-autofill";

/**
 * 新建向导「选文件 → 自动填名字/mmproj」的纯逻辑（批 D 第 2 条）。
 * 三层判定分别测：
 * 1. 单个文件 → 建议的 name/displayName（slug 化 vs 保留大小写）
 * 2. 同目录 mmproj 候选的挑选
 * 3. 「换文件要不要覆盖用户已经手动改过的值」——这条最容易出错，独立成组
 */

const item = (overrides: Partial<PickerItem>): PickerItem => ({
  value: "main/model.gguf",
  dir: "main",
  label: "model.gguf",
  kind: "model",
  quant: null,
  shards: 1,
  shardTotalDeclared: null,
  totalSize: 0,
  refs: 0,
  ...overrides,
});

describe("suggestNamesFromFile", () => {
  it("单文件：去掉 .gguf 后缀，name 走 slug 化，displayName 保留原始大小写", () => {
    const picked = item({ label: "Qwen3.5-4B-Q4_K_M.gguf" });
    expect(suggestNamesFromFile(picked)).toEqual({
      name: "qwen3-5-4b-q4-k-m",
      displayName: "Qwen3.5-4B-Q4_K_M",
    });
  });

  it("分片组：label 本就没有 .gguf 尾巴（buildPickerItems 已经去掉通配），原样使用", () => {
    const picked = item({ label: "Qwen3-35B-Q4_K_M", shards: 3, shardTotalDeclared: 3 });
    expect(suggestNamesFromFile(picked)).toEqual({
      name: "qwen3-35b-q4-k-m",
      displayName: "Qwen3-35B-Q4_K_M",
    });
  });
});

describe("pickSiblingMmproj", () => {
  const model = item({ value: "main/model.gguf", dir: "main", label: "model.gguf" });

  it("同目录下有 mmproj 时选中它", () => {
    const mmproj = item({ value: "main/mmproj-F16.gguf", dir: "main", label: "mmproj-F16.gguf", kind: "mmproj" });
    expect(pickSiblingMmproj([model, mmproj], model)).toBe("main/mmproj-F16.gguf");
  });

  it("没有 mmproj 时返回 null，不瞎选", () => {
    expect(pickSiblingMmproj([model], model)).toBeNull();
  });

  it("有多个同目录 mmproj 取第一个（buildPickerItems 已按 label 排好序）", () => {
    const a = item({ value: "main/mmproj-a.gguf", dir: "main", label: "mmproj-a.gguf", kind: "mmproj" });
    const b = item({ value: "main/mmproj-b.gguf", dir: "main", label: "mmproj-b.gguf", kind: "mmproj" });
    expect(pickSiblingMmproj([model, a, b], model)).toBe("main/mmproj-a.gguf");
  });

  it("不同目录的 mmproj 不算同仓库，不选", () => {
    const other = item({ value: "other/mmproj-F16.gguf", dir: "other", label: "mmproj-F16.gguf", kind: "mmproj" });
    expect(pickSiblingMmproj([model, other], model)).toBeNull();
  });
});

describe("applyAutofill：换文件时该不该覆盖用户已手动改过的值", () => {
  it("当前值为空 → 套用新建议", () => {
    expect(applyAutofill({ value: "", lastAuto: "" }, "qwen3-8b")).toEqual({
      value: "qwen3-8b",
      lastAuto: "qwen3-8b",
    });
  });

  it("当前值仍是上一次自动填入的值（未手动改过）→ 套用新建议", () => {
    expect(applyAutofill({ value: "qwen3-8b", lastAuto: "qwen3-8b" }, "qwen3-14b")).toEqual({
      value: "qwen3-14b",
      lastAuto: "qwen3-14b",
    });
  });

  it("用户已手动改过（当前值既非空也不是上次自动填的值）→ 保持不变，不覆盖", () => {
    expect(applyAutofill({ value: "my-custom-name", lastAuto: "qwen3-8b" }, "qwen3-14b")).toEqual({
      value: "my-custom-name",
      lastAuto: "qwen3-8b",
    });
  });

  it("手动改过之后再换一次文件仍然不覆盖——lastAuto 冻结在最后一次真正生效的自动值上", () => {
    const afterManualEdit = applyAutofill({ value: "my-custom-name", lastAuto: "qwen3-8b" }, "qwen3-14b");
    const afterAnotherFileChange = applyAutofill(afterManualEdit, "qwen3-30b");
    expect(afterAnotherFileChange).toEqual({ value: "my-custom-name", lastAuto: "qwen3-8b" });
  });
});

describe("computeAutofill：选中新文件时对 name/displayName/mmproj 三个字段一起判定", () => {
  const modelA = item({ value: "main/a-Q4_K_M.gguf", dir: "main", label: "a-Q4_K_M.gguf" });
  const modelB = item({ value: "main/b-Q4_K_M.gguf", dir: "main", label: "b-Q4_K_M.gguf" });
  const mmprojMain = item({ value: "main/mmproj-F16.gguf", dir: "main", label: "mmproj-F16.gguf", kind: "mmproj" });
  const items = [modelA, modelB, mmprojMain];

  it("全部字段都还是初始态（空/上次自动值）时，三个字段都跟着新文件重算", () => {
    const current = {
      name: { value: "a-q4-k-m", lastAuto: "a-q4-k-m" },
      displayName: { value: "a-Q4_K_M", lastAuto: "a-Q4_K_M" },
      mmproj: { value: "main/mmproj-F16.gguf", lastAuto: "main/mmproj-F16.gguf" },
    };
    const next = computeAutofill(items, modelB, current);
    expect(next.name.value).toBe("b-q4-k-m");
    expect(next.displayName.value).toBe("b-Q4_K_M");
    expect(next.mmproj.value).toBe("main/mmproj-F16.gguf");
  });

  it("用户手动改过 name，换文件后 name 不变、displayName 与 mmproj 仍正常重算", () => {
    const current = {
      name: { value: "my-custom-name", lastAuto: "a-q4-k-m" },
      displayName: { value: "a-Q4_K_M", lastAuto: "a-Q4_K_M" },
      mmproj: { value: "main/mmproj-F16.gguf", lastAuto: "main/mmproj-F16.gguf" },
    };
    const next = computeAutofill(items, modelB, current);
    expect(next.name.value).toBe("my-custom-name");
    expect(next.displayName.value).toBe("b-Q4_K_M");
    expect(next.mmproj.value).toBe("main/mmproj-F16.gguf");
  });

  it("用户手动清空过 mmproj（改成没有）不算未手动改过——只有空串本身会被当成初始态重算", () => {
    // 注意：mmproj 的「未选」用空串表达，这与「name/displayName 为空即初始态」
    // 语义相同——用户手动清空之后又变回了「看起来像初始态」的空串，会被当成
    // 未手动改过而重新选中。这是 value 相等判定法的已知取舍（brief 明确认可），
    // 不是缺陷。
    const current = {
      name: { value: "a-q4-k-m", lastAuto: "a-q4-k-m" },
      displayName: { value: "a-Q4_K_M", lastAuto: "a-Q4_K_M" },
      mmproj: { value: "", lastAuto: "main/mmproj-F16.gguf" },
    };
    const next = computeAutofill(items, modelB, current);
    expect(next.mmproj.value).toBe("main/mmproj-F16.gguf");
  });
});

describe("computeInitialAutofill：向导挂载时按深链预选的文件算初值", () => {
  const modelA = item({ value: "main/a-Q4_K_M.gguf", dir: "main", label: "a-Q4_K_M.gguf" });
  const mmprojMain = item({ value: "main/mmproj-F16.gguf", dir: "main", label: "mmproj-F16.gguf", kind: "mmproj" });
  const items = [modelA, mmprojMain];

  it("没有预选文件时三个字段都是空", () => {
    expect(computeInitialAutofill(items, null)).toEqual({
      ggufFile: "",
      name: "",
      displayName: "",
      mmproj: "",
    });
  });

  it("预选文件命中候选项时，name/displayName/mmproj 一起算出来", () => {
    expect(computeInitialAutofill(items, "main/a-Q4_K_M.gguf")).toEqual({
      ggufFile: "main/a-Q4_K_M.gguf",
      name: "a-q4-k-m",
      displayName: "a-Q4_K_M",
      mmproj: "main/mmproj-F16.gguf",
    });
  });

  it("预选文件不在候选列表里（理论上不该发生，仍要有兜底）时只填 ggufFile", () => {
    expect(computeInitialAutofill(items, "main/not-in-list.gguf")).toEqual({
      ggufFile: "main/not-in-list.gguf",
      name: "",
      displayName: "",
      mmproj: "",
    });
  });
});
