import { describe, expect, it } from "vitest";
import {
  planRename,
  renameShardGroupFiles,
  rewriteRefBasename,
  rewriteRefFolder,
  shardGroupMembers,
} from "./file-move-plan";

/**
 * file-move-plan 纯逻辑测试（T2，设计 §2.3/§2.4，无 IO）
 *
 * 覆盖任务要求的必测点：分片组整组升级、改名后 glob 仍能匹配到全部分片、
 * 单文件改名 vs 分片组改前缀两条分支、引用值重写（glob 与精确路径两种形态）、
 * 移动后引用值目录段正确替换。
 */

/** 与 fsScanner.globSegmentToRegExp 同款方言（* → 任意、? → 单字符），
 * 用于验证"改名后 glob 仍能匹配到全部分片"——只测试逻辑，不依赖生产代码私有实现 */
function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (const ch of pattern) {
    if (ch === "*") source += "[^/]*";
    else if (ch === "?") source += "[^/]";
    else if (/[.*+?^${}()|[\]\\]/.test(ch)) source += `\\${ch}`;
    else source += ch;
  }
  return new RegExp(`^${source}$`);
}

describe("shardGroupMembers：分片组整组升级", () => {
  const files = [
    "qwen-00001-of-00003.gguf",
    "qwen-00002-of-00003.gguf",
    "qwen-00003-of-00003.gguf",
    "other-00001-of-00002.gguf",
    "other-00002-of-00002.gguf",
    "readme.txt",
  ];

  it("选中组内任一分片，都升级为同一整组（成员齐全、按名排序）", () => {
    const expected = ["qwen-00001-of-00003.gguf", "qwen-00002-of-00003.gguf", "qwen-00003-of-00003.gguf"];
    expect(shardGroupMembers(files, "qwen-00001-of-00003.gguf")).toEqual(expected);
    expect(shardGroupMembers(files, "qwen-00002-of-00003.gguf")).toEqual(expected); // 选中中间片同样升级
    expect(shardGroupMembers(files, "qwen-00003-of-00003.gguf")).toEqual(expected); // 选中末片同样升级
  });

  it("不会混入前缀不同的其它分片组", () => {
    expect(shardGroupMembers(files, "other-00001-of-00002.gguf")).toEqual([
      "other-00001-of-00002.gguf",
      "other-00002-of-00002.gguf",
    ]);
  });

  it("非分片命名文件只返回自身", () => {
    expect(shardGroupMembers(files, "readme.txt")).toEqual(["readme.txt"]);
  });

  it("缺片场景：目录里只剩部分分片，组内成员按现存的来，不臆造缺失项", () => {
    const partial = ["qwen-00001-of-00003.gguf", "qwen-00003-of-00003.gguf"]; // 缺 00002
    expect(shardGroupMembers(partial, "qwen-00001-of-00003.gguf")).toEqual([
      "qwen-00001-of-00003.gguf",
      "qwen-00003-of-00003.gguf",
    ]);
  });
});

describe("rewriteRefFolder：移动后引用值的目录段正确替换", () => {
  it("精确路径：只换首段，文件名不变", () => {
    expect(rewriteRefFolder("main/qwen-Q8_0.gguf", "shared")).toBe("shared/qwen-Q8_0.gguf");
  });

  it("glob 路径：只换首段，通配符尾缀原样保留", () => {
    expect(rewriteRefFolder("main/qwen-*.gguf", "shared")).toBe("shared/qwen-*.gguf");
  });

  it("无目录段（裸文件名）：补上目标目录前缀", () => {
    expect(rewriteRefFolder("qwen-Q8_0.gguf", "shared")).toBe("shared/qwen-Q8_0.gguf");
  });

  it("多级目录段：整段目录路径被替换，只保留 basename（阶段 3a）", () => {
    expect(rewriteRefFolder("main/70b/qwen-Q8_0.gguf", "shared")).toBe("shared/qwen-Q8_0.gguf");
  });

  it("目标目录本身也可以是多级路径", () => {
    expect(rewriteRefFolder("main/qwen-Q8_0.gguf", "shared/70b")).toBe("shared/70b/qwen-Q8_0.gguf");
  });
});

describe("rewriteRefBasename：改名后引用值重写（glob 与精确路径两种形态）", () => {
  it("精确路径：oldPrefix 传完整旧文件名，整串替换为新文件名", () => {
    expect(rewriteRefBasename("main/qwen-Q8_0.gguf", "qwen-Q8_0.gguf", "qwen-v2-Q8_0.gguf")).toBe(
      "main/qwen-v2-Q8_0.gguf",
    );
  });

  it("glob：oldPrefix 传分片组前缀，通配尾缀原样保留", () => {
    expect(rewriteRefBasename("main/qwen-*.gguf", "qwen", "qwen-v2")).toBe("main/qwen-v2-*.gguf");
  });

  it("basename 与 oldPrefix 不匹配时原样返回（防御）", () => {
    expect(rewriteRefBasename("main/other-*.gguf", "qwen", "qwen-v2")).toBe("main/other-*.gguf");
  });
});

describe("renameShardGroupFiles：分片组只改前缀，序号段（含量化后缀）原样保留", () => {
  it("普通分片序号段保留", () => {
    const group = ["qwen-00001-of-00003.gguf", "qwen-00002-of-00003.gguf", "qwen-00003-of-00003.gguf"];
    expect(renameShardGroupFiles(group, "qwen-v2")).toEqual([
      { oldName: "qwen-00001-of-00003.gguf", newName: "qwen-v2-00001-of-00003.gguf" },
      { oldName: "qwen-00002-of-00003.gguf", newName: "qwen-v2-00002-of-00003.gguf" },
      { oldName: "qwen-00003-of-00003.gguf", newName: "qwen-v2-00003-of-00003.gguf" },
    ]);
  });

  it("序号段后夹带量化后缀同样原样保留", () => {
    const group = ["qwen-00001-of-00002.Q8_0.gguf", "qwen-00002-of-00002.Q8_0.gguf"];
    expect(renameShardGroupFiles(group, "qwen-heretic")).toEqual([
      { oldName: "qwen-00001-of-00002.Q8_0.gguf", newName: "qwen-heretic-00001-of-00002.Q8_0.gguf" },
      { oldName: "qwen-00002-of-00002.Q8_0.gguf", newName: "qwen-heretic-00002-of-00002.Q8_0.gguf" },
    ]);
  });

  it("改名后重新拼出的 glob 仍能匹配到全部改名后的分片（最容易写塌的一条）", () => {
    const group = ["qwen-00001-of-00003.gguf", "qwen-00002-of-00003.gguf", "qwen-00003-of-00003.gguf"];
    const renamed = renameShardGroupFiles(group, "qwen-v2");
    const newGlob = rewriteRefBasename("main/qwen-*.gguf", "qwen", "qwen-v2");
    expect(newGlob).toBe("main/qwen-v2-*.gguf");

    const globBasename = newGlob.slice(newGlob.indexOf("/") + 1);
    const re = globToRegExp(globBasename);
    for (const { newName } of renamed) {
      expect(re.test(newName)).toBe(true);
    }
    // 旧文件名不应再匹配新 glob（改名已生效，不是意外的宽松匹配）
    for (const { oldName } of renamed) {
      expect(re.test(oldName)).toBe(false);
    }
  });
});

describe("planRename：单文件改名 vs 分片组改前缀两条分支", () => {
  it("单文件分支：newValue 是完整新文件名，refRewrite 整串替换", () => {
    const plan = planRename(["qwen-Q8_0.gguf"], "qwen-Q8_0.gguf", "qwen-renamed.gguf");
    expect(plan.files).toEqual([{ oldName: "qwen-Q8_0.gguf", newName: "qwen-renamed.gguf" }]);
    expect(plan.refRewrite).toEqual({ oldPrefix: "qwen-Q8_0.gguf", newPrefix: "qwen-renamed.gguf" });
    expect(rewriteRefBasename("main/qwen-Q8_0.gguf", plan.refRewrite.oldPrefix, plan.refRewrite.newPrefix)).toBe(
      "main/qwen-renamed.gguf",
    );
  });

  it("分片组分支：newValue 是新前缀，序号段原样保留，refRewrite 只换前缀", () => {
    const group = ["qwen-00001-of-00002.gguf", "qwen-00002-of-00002.gguf"];
    const plan = planRename(group, "qwen-00001-of-00002.gguf", "qwen-v2");
    expect(plan.files).toEqual([
      { oldName: "qwen-00001-of-00002.gguf", newName: "qwen-v2-00001-of-00002.gguf" },
      { oldName: "qwen-00002-of-00002.gguf", newName: "qwen-v2-00002-of-00002.gguf" },
    ]);
    expect(plan.refRewrite).toEqual({ oldPrefix: "qwen", newPrefix: "qwen-v2" });
    expect(rewriteRefBasename("main/qwen-*.gguf", plan.refRewrite.oldPrefix, plan.refRewrite.newPrefix)).toBe(
      "main/qwen-v2-*.gguf",
    );
  });
});
