import { describe, expect, it } from "vitest";
import { groupIdentityKey, groupRepoFiles, type RepoFile } from "./quant";

/**
 * groupRepoFiles 测试（M2 Task 2，纯函数无 IO）
 *
 * 行为锚定（HF 仓库真实文件名样本）：
 * - 仅 .gguf 进入分组，其余（safetensors/bin/md/png）直接排除
 * - 分组键 = kind + 量化标签 + 分片组前缀（或单文件全名）：
 *   同量化不同前缀各自成组（unsloth 一仓库多尺寸），同组分片按 index 升序
 * - mmproj* 开头的 basename 是投影文件（kind=mmproj），排在模型组之后
 * - 组按 totalSize 降序；shardTotalDeclared 与 files.length 不符照常输出（UI 提示缺片）
 */
const f = (path: string, size = 1): RepoFile => ({ path, size });

describe("groupRepoFiles：单文件与分片归组", () => {
  it("单文件 Qwen3-32B-Q4_K_M.gguf → 1 组，shards=1、无声明总数", () => {
    const groups = groupRepoFiles([f("Qwen3-32B-Q4_K_M.gguf", 100)]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      quant: "Q4_K_M",
      label: "Q4_K_M",
      kind: "model",
      totalSize: 100,
      shards: 1,
      shardTotalDeclared: null,
    });
    expect(groups[0].files.map((x) => x.path)).toEqual(["Qwen3-32B-Q4_K_M.gguf"]);
  });

  it("bartowski 三件套（乱序输入）→ 1 组 shards=3、totalSize 求和、按 index 升序", () => {
    const paths = [
      "Qwen3-32B-Q4_K_M-00003-of-00003.gguf",
      "Qwen3-32B-Q4_K_M-00001-of-00003.gguf",
      "Qwen3-32B-Q4_K_M-00002-of-00003.gguf",
    ];
    const groups = groupRepoFiles(paths.map((p, i) => f(p, (i + 1) * 100)));
    expect(groups).toHaveLength(1);
    const g = groups[0];
    expect(g.quant).toBe("Q4_K_M");
    expect(g.kind).toBe("model");
    expect(g.shards).toBe(3);
    expect(g.shardTotalDeclared).toBe(3);
    expect(g.files.map((x) => x.path)).toEqual([paths[1], paths[2], paths[0]]);
    expect(g.totalSize).toBe(600);
  });

  it("量化串在分片段之后（model-0000N-of-00002.Q8_0.gguf）→ 1 组 Q8_0 shards=2", () => {
    const groups = groupRepoFiles([
      f("model-00002-of-00002.Q8_0.gguf", 2),
      f("model-00001-of-00002.Q8_0.gguf", 1),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].quant).toBe("Q8_0");
    expect(groups[0].shards).toBe(2);
    expect(groups[0].files.map((x) => x.path)).toEqual([
      "model-00001-of-00002.Q8_0.gguf",
      "model-00002-of-00002.Q8_0.gguf",
    ]);
  });

  it("同仓库 Q8_0 与 Q4_K_M 并存 → 2 组（按大小降序），同一文件绝不出现在两组", () => {
    const groups = groupRepoFiles([f("Qwen3-8B-Q8_0.gguf", 500), f("Qwen3-8B-Q4_K_M.gguf", 300)]);
    expect(groups.map((g) => g.quant)).toEqual(["Q8_0", "Q4_K_M"]);
    expect(groups.map((g) => g.totalSize)).toEqual([500, 300]);
    const all = groups.flatMap((g) => g.files.map((x) => x.path));
    expect(new Set(all).size).toBe(2);
  });

  it("unsloth 式：同量化不同前缀（8B 与 14B 各一套 Q4_K_M）→ 2 组", () => {
    const groups = groupRepoFiles([f("Qwen3-8B-Q4_K_M.gguf", 100), f("Qwen3-14B-Q4_K_M.gguf", 200)]);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.quant === "Q4_K_M")).toBe(true);
    expect(groups.map((g) => g.files[0].path)).toEqual([
      "Qwen3-14B-Q4_K_M.gguf",
      "Qwen3-8B-Q4_K_M.gguf",
    ]);
  });
});

describe("groupRepoFiles：量化标签识别", () => {
  it("IQ4_XS / Q6_K / BF16 / F16 / Q8_0 各自成组且识别正确", () => {
    const groups = groupRepoFiles([
      f("DeepSeek-R1-IQ4_XS.gguf"),
      f("gemma-3-27b-it-Q6_K.gguf"),
      f("glm-4.5-air-BF16.gguf"),
      f("model-F16.gguf"),
      f("qwen-2.5-7b-q8_0.gguf"),
    ]);
    expect(groups).toHaveLength(5);
    const byPath = new Map(groups.flatMap((g) => g.files.map((x) => [x.path, g.quant] as const)));
    expect(byPath.get("DeepSeek-R1-IQ4_XS.gguf")).toBe("IQ4_XS");
    expect(byPath.get("gemma-3-27b-it-Q6_K.gguf")).toBe("Q6_K");
    expect(byPath.get("glm-4.5-air-BF16.gguf")).toBe("BF16");
    expect(byPath.get("model-F16.gguf")).toBe("F16");
    expect(byPath.get("qwen-2.5-7b-q8_0.gguf")).toBe("Q8_0");
  });

  it("无量化标识 my-model.gguf → quant=null、label=未识别", () => {
    const groups = groupRepoFiles([f("my-model.gguf", 10)]);
    expect(groups).toHaveLength(1);
    expect(groups[0].quant).toBeNull();
    expect(groups[0].label).toBe("未识别");
    expect(groups[0].kind).toBe("model");
  });
});

describe("groupRepoFiles：mmproj 投影文件", () => {
  it("mmproj-F16.gguf → kind=mmproj、quant=F16；mmproj-model.gguf → quant=null", () => {
    const groups = groupRepoFiles([f("mmproj-F16.gguf", 10), f("mmproj-model.gguf", 5)]);
    expect(groups).toHaveLength(2); // 同为 mmproj、量化不同 → 两组
    const f16 = groups.find((g) => g.files[0].path === "mmproj-F16.gguf");
    const plain = groups.find((g) => g.files[0].path === "mmproj-model.gguf");
    expect(f16).toMatchObject({ kind: "mmproj", quant: "F16", label: "F16" });
    expect(plain).toMatchObject({ kind: "mmproj", quant: null, label: "未识别" });
  });

  it("mmproj 与同量化模型文件分属两组（kind 参与分组键）", () => {
    const groups = groupRepoFiles([f("model-F16.gguf", 100), f("mmproj-F16.gguf", 10)]);
    expect(groups).toHaveLength(2);
    const model = groups.find((g) => g.kind === "model");
    const mmproj = groups.find((g) => g.kind === "mmproj");
    expect(model?.files[0].path).toBe("model-F16.gguf");
    expect(mmproj?.files[0].path).toBe("mmproj-F16.gguf");
  });
});

describe("groupRepoFiles：路径与过滤", () => {
  it("子目录路径按 basename 识别量化，path 原样保留", () => {
    const path = "Qwen3-32B-Q4_K_M/Qwen3-32B-Q4_K_M.gguf";
    const groups = groupRepoFiles([f(path, 42)]);
    expect(groups).toHaveLength(1);
    expect(groups[0].quant).toBe("Q4_K_M");
    expect(groups[0].files[0].path).toBe(path);
  });

  it("非 gguf（safetensors/md/png）不进入任何组", () => {
    const groups = groupRepoFiles([
      f("model.safetensors", 1000),
      f("README.md", 5),
      f("mmproj.png", 3),
      f("Qwen3-8B-Q4_K_M.gguf", 200),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].files.map((x) => x.path)).toEqual(["Qwen3-8B-Q4_K_M.gguf"]);
  });

  it("空输入 / 全非 gguf → 空数组", () => {
    expect(groupRepoFiles([])).toEqual([]);
    expect(groupRepoFiles([f("model.safetensors", 1), f("README.md", 1)])).toEqual([]);
  });
});

describe("groupRepoFiles：缺片与排序", () => {
  it("缺片：of-00003 命名只到 2 个文件 → shards=2、shardTotalDeclared=3 照常输出", () => {
    const groups = groupRepoFiles([f("model-00001-of-00003.gguf", 1), f("model-00002-of-00003.gguf", 1)]);
    expect(groups).toHaveLength(1);
    expect(groups[0].files).toHaveLength(2);
    expect(groups[0].shards).toBe(2);
    expect(groups[0].shardTotalDeclared).toBe(3);
  });

  it("组按 totalSize 降序，mmproj 组排在全部模型组之后", () => {
    const groups = groupRepoFiles([
      f("model-Q4_K_M.gguf", 100),
      f("mmproj-F16.gguf", 50),
      f("model-Q8_0.gguf", 200),
      f("mmproj-model.gguf", 10),
    ]);
    expect(groups.map((g) => g.kind)).toEqual(["model", "model", "mmproj", "mmproj"]);
    expect(groups.map((g) => g.totalSize)).toEqual([200, 100, 50, 10]);
  });
});

describe("groupIdentityKey", () => {
  it("相同输入 → 同键", () => {
    expect(groupIdentityKey("model", ["a.gguf", "b.gguf"])).toBe(groupIdentityKey("model", ["a.gguf", "b.gguf"]));
  });

  it("kind 不同 → 异键", () => {
    expect(groupIdentityKey("model", ["a.gguf"])).not.toBe(groupIdentityKey("mmproj", ["a.gguf"]));
  });

  it("文件名列表顺序不同 → 异键（顺序是身份的一部分）", () => {
    expect(groupIdentityKey("model", ["a.gguf", "b.gguf"])).not.toBe(groupIdentityKey("model", ["b.gguf", "a.gguf"]));
  });

  // JSON 序列化而非 join 分隔符正是为了防这种碰撞：若用逗号拼接，
  // ["a,b"] 与 ["a", "b"] 会拼出同一个字符串——用真实可能出现在文件名里的
  // 字符（逗号、引号、路径分隔符）各试一遍，确认都不会被拼花
  it("文件名含 , \" / 等字符不与另一组碰撞", () => {
    expect(groupIdentityKey("model", ["a,b"])).not.toBe(groupIdentityKey("model", ["a", "b"]));
    expect(groupIdentityKey("model", ['a"b'])).not.toBe(groupIdentityKey("model", ['a"', "b"]));
    expect(groupIdentityKey("model", ["a/b"])).not.toBe(groupIdentityKey("model", ["a", "b"]));
  });
});
