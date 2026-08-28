import { describe, expect, it } from "vitest";
import { buildPickerItems, pathForGroup, type PickerFile } from "./model-file-picker";

/**
 * 文件树 → 弹层可选项。核心是三件事：
 * 1. 分片按组归并为一项（选中单片会得到一个启动就报错的配置）
 * 2. mmproj 排在后面但**照常可选**（规格 §2 第 5 条：不硬过滤）
 * 3. 非标准命名（detectQuant 认不出）不能消失
 */

const f = (rel: string, size = 1000, refs = 0): PickerFile => ({ rel, size, mtime: 0, refs });

describe("pathForGroup", () => {
  it("单文件 → 原路径", () => {
    expect(pathForGroup([{ path: "main/qwen3-8b-Q4_K_M.gguf" }])).toBe("main/qwen3-8b-Q4_K_M.gguf");
  });

  it("分片组 → 首片前缀 + -*.gguf（前缀含命名空间目录）", () => {
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
    expect(items.map((i) => [i.value, i.label, i.shards, i.refs])).toEqual([
      ["main/a-Q4_K_M.gguf", "a-Q4_K_M.gguf", 1, 2],
      ["main/b-Q8_0.gguf", "b-Q8_0.gguf", 1, 0],
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
});
