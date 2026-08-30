import { describe, expect, it } from "vitest";
import { buildPickerItems, groupByDir, pathForGroup, type PickerFile, type PickerItem } from "./model-file-picker";

/**
 * 文件树 → 弹层可选项。核心是四件事：
 * 1. 分片按组归并为一项（选中单片会得到一个启动就报错的配置）
 * 2. mmproj 排在后面但**照常可选**（规格 §2 第 5 条：不硬过滤）
 * 3. 非标准命名（detectQuant 认不出）不能消失
 * 4. 目录可区分（规格 §4.2）：models 目录按一级目录平铺、跨目录引用是既有
 *    语义，同名文件分属不同目录时 label 完全相同，必须靠 dir 字段与排序
 *    把它们分开，不能让用户靠猜
 */

const f = (rel: string, size = 1000, refs = 0): PickerFile => ({ rel, size, mtime: 0, refs });

describe("pathForGroup", () => {
  it("单文件 → 原路径", () => {
    expect(pathForGroup([{ path: "main/qwen3-8b-Q4_K_M.gguf" }])).toBe("main/qwen3-8b-Q4_K_M.gguf");
  });

  it("分片组 → 首片前缀 + -*.gguf（前缀含目录）", () => {
    expect(
      pathForGroup([
        { path: "main/Qwen3-35B-Q4_K_M-00001-of-00005.gguf" },
        { path: "main/Qwen3-35B-Q4_K_M-00002-of-00005.gguf" },
      ]),
    ).toBe("main/Qwen3-35B-Q4_K_M-*.gguf");
  });
});

describe("buildPickerItems", () => {
  it("单文件各成一项，value 是可直接写入 gguf_file 的相对路径", () => {
    const items = buildPickerItems([f("main/a-Q4_K_M.gguf", 100, 2), f("main/b-Q8_0.gguf", 200)]);
    expect(items.map((i) => [i.value, i.dir, i.label, i.shards, i.refs])).toEqual([
      ["main/a-Q4_K_M.gguf", "main", "a-Q4_K_M.gguf", 1, 2],
      ["main/b-Q8_0.gguf", "main", "b-Q8_0.gguf", 1, 0],
    ]);
  });

  it("完整分片组归并为一项：value 是 glob、label 去掉通配、体积求和", () => {
    const items = buildPickerItems([
      f("main/Qwen3-35B-Q4_K_M-00001-of-00003.gguf", 100, 1),
      f("main/Qwen3-35B-Q4_K_M-00002-of-00003.gguf", 200, 1),
      f("main/Qwen3-35B-Q4_K_M-00003-of-00003.gguf", 300, 1),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      value: "main/Qwen3-35B-Q4_K_M-*.gguf",
      dir: "main",
      label: "Qwen3-35B-Q4_K_M",
      kind: "model",
      quant: "Q4_K_M",
      shards: 3,
      shardTotalDeclared: 3,
      totalSize: 600,
      refs: 1,
    });
  });

  it("缺片的分片组仍归并为一项，shards 与声明总数不符（供 UI 提示）", () => {
    const items = buildPickerItems([
      f("main/Qwen3-35B-Q4_K_M-00001-of-00005.gguf"),
      f("main/Qwen3-35B-Q4_K_M-00002-of-00005.gguf"),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].shards).toBe(2);
    expect(items[0].shardTotalDeclared).toBe(5);
  });

  it("非标准命名（识别不出量化）仍然出现在列表里，quant 为 null", () => {
    const items = buildPickerItems([f("main/my-custom-model.gguf")]);
    expect(items).toHaveLength(1);
    expect(items[0].quant).toBeNull();
    expect(items[0].value).toBe("main/my-custom-model.gguf");
  });

  it("mmproj 归入 mmproj 类且排在全部模型项之后（排序靠后，不是过滤掉）", () => {
    const items = buildPickerItems([
      f("main/mmproj-F16.gguf"),
      f("main/zzz-model-Q4_K_M.gguf"),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["model", "mmproj"]);
    expect(items.map((i) => i.value)).toEqual(["main/zzz-model-Q4_K_M.gguf", "main/mmproj-F16.gguf"]);
  });

  it("同类内按 label 升序（弹层要能按名字找，而不是按体积）", () => {
    const items = buildPickerItems([
      f("main/c-Q4_K_M.gguf", 900),
      f("main/a-Q4_K_M.gguf", 100),
      f("main/b-Q4_K_M.gguf", 500),
    ]);
    expect(items.map((i) => i.label)).toEqual(["a-Q4_K_M.gguf", "b-Q4_K_M.gguf", "c-Q4_K_M.gguf"]);
  });

  it("非 .gguf 文件不进列表（gguf_file 字段只接受 .gguf）", () => {
    expect(buildPickerItems([f("main/readme.md"), f("main/config.json")])).toEqual([]);
  });

  it("空输入 → 空列表", () => {
    expect(buildPickerItems([])).toEqual([]);
  });

  it("同名文件分属不同目录：label 相同但 dir 与 value 能区分开", () => {
    const items = buildPickerItems([f("main/qwen3-8b-Q4_K_M.gguf"), f("test/qwen3-8b-Q4_K_M.gguf")]);
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.label)).toEqual(["qwen3-8b-Q4_K_M.gguf", "qwen3-8b-Q4_K_M.gguf"]);
    expect(items.map((i) => [i.dir, i.value])).toEqual([
      ["main", "main/qwen3-8b-Q4_K_M.gguf"],
      ["test", "test/qwen3-8b-Q4_K_M.gguf"],
    ]);
  });

  it("排序以 dir 为主键、label 为次键（同类内先分组再按名）", () => {
    const items = buildPickerItems([
      f("zeta/a-Q4_K_M.gguf"),
      f("alpha/b-Q4_K_M.gguf"),
      f("alpha/a-Q4_K_M.gguf"),
    ]);
    expect(items.map((i) => [i.dir, i.label])).toEqual([
      ["alpha", "a-Q4_K_M.gguf"],
      ["alpha", "b-Q4_K_M.gguf"],
      ["zeta", "a-Q4_K_M.gguf"],
    ]);
  });

  it("多级目录：dir 取完整目录路径，不只是首段（阶段 3a）", () => {
    const items = buildPickerItems([f("main/70b/a-Q4_K_M.gguf")]);
    expect(items).toHaveLength(1);
    expect(items[0].dir).toBe("main/70b");
    expect(items[0].value).toBe("main/70b/a-Q4_K_M.gguf");
  });

  it("根下文件（无目录前缀）：dir 为空串", () => {
    const items = buildPickerItems([f("a-Q4_K_M.gguf")]);
    expect(items).toHaveLength(1);
    expect(items[0].dir).toBe("");
    expect(items[0].value).toBe("a-Q4_K_M.gguf");
  });
});

describe("groupByDir", () => {
  const item = (dir: string, label: string): PickerItem => ({
    value: `${dir}/${label}`,
    dir,
    label,
    kind: "model",
    quant: null,
    shards: 1,
    shardTotalDeclared: null,
    totalSize: 0,
    refs: 0,
  });

  it("连续同目录的项合并为一组，组内保留原有顺序", () => {
    const groups = groupByDir([
      item("main", "a.gguf"),
      item("main", "b.gguf"),
      item("qwen3.6", "c.gguf"),
    ]);
    expect(groups.map((g) => [g.dir, g.items.map((i) => i.label)])).toEqual([
      ["main", ["a.gguf", "b.gguf"]],
      ["qwen3.6", ["c.gguf"]],
    ]);
  });

  it("空输入 → 空分组列表", () => {
    expect(groupByDir([])).toEqual([]);
  });
});
