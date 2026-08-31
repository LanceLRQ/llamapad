import { describe, expect, it } from "vitest";

import {
  isValidBaseDir,
  isValidRepoId,
  repoDirOf,
  repoTargetDir,
  suggestDisplayName,
  suggestModelName,
} from "./repo-path";

describe("repoTargetDir", () => {
  it("base 非空时拼在 repo 前面", () => {
    expect(repoTargetDir("hf", "unsloth/Qwen3.5-4B-GGUF")).toBe("hf/unsloth/Qwen3.5-4B-GGUF");
  });

  it("base 为空串表示 models 根，直接用 repo 当路径", () => {
    expect(repoTargetDir("", "unsloth/Qwen3.5-4B-GGUF")).toBe("unsloth/Qwen3.5-4B-GGUF");
  });

  it("base 是多级目录时同样只做拼接", () => {
    expect(repoTargetDir("a/b", "o/r")).toBe("a/b/o/r");
  });
});

describe("isValidRepoId", () => {
  it("接受标准的 owner/name 两段式", () => {
    expect(isValidRepoId("unsloth/Qwen3.5-4B-GGUF")).toBe(true);
  });

  it("接受含点与下划线的仓库名", () => {
    expect(isValidRepoId("TheBloke/Llama-2_7B.Q4")).toBe(true);
  });

  it("拒绝空串", () => {
    expect(isValidRepoId("")).toBe(false);
  });

  it("拒绝 .. 段——它会穿透出 models 根", () => {
    expect(isValidRepoId("../etc")).toBe(false);
  });

  it("拒绝以点开头的段——那会变成隐藏目录，scanTree 扫不到", () => {
    expect(isValidRepoId(".hidden/repo")).toBe(false);
  });

  it("拒绝前导斜杠（绝对路径）", () => {
    expect(isValidRepoId("/unsloth/x")).toBe(false);
  });

  it("拒绝连续斜杠产生的空段", () => {
    expect(isValidRepoId("unsloth//x")).toBe(false);
  });
});

describe("isValidBaseDir", () => {
  it("空串合法——代表 models 根", () => {
    expect(isValidBaseDir("")).toBe(true);
  });

  it("接受普通目录名", () => {
    expect(isValidBaseDir("hf")).toBe(true);
  });

  it("接受上一批放开的带点目录名", () => {
    expect(isValidBaseDir("qwen3.8")).toBe(true);
  });

  it("拒绝 .. 段", () => {
    expect(isValidBaseDir("../x")).toBe(false);
  });

  it("拒绝拼接后超过 8 层的深度", () => {
    expect(isValidBaseDir("a/b/c/d/e/f/g/h/i")).toBe(false);
  });
});

describe("repoDirOf", () => {
  const dirs = ["hf/unsloth/Qwen3.5-4B-GGUF", "qwen3.8/bartowski/X-GGUF"];

  it("文件在某档案目录内时返回该目录", () => {
    expect(repoDirOf("hf/unsloth/Qwen3.5-4B-GGUF/Q4_K_M.gguf", dirs)).toBe(
      "hf/unsloth/Qwen3.5-4B-GGUF",
    );
  });

  it("档案目录自身也算命中", () => {
    expect(repoDirOf("hf/unsloth/Qwen3.5-4B-GGUF", dirs)).toBe("hf/unsloth/Qwen3.5-4B-GGUF");
  });

  it("不在任何档案目录内时返回 null", () => {
    expect(repoDirOf("main/foo.gguf", dirs)).toBeNull();
  });

  it("同名前缀但不是目录边界的不算命中（Qwen3.5-4B-GGUF-extra）", () => {
    expect(repoDirOf("hf/unsloth/Qwen3.5-4B-GGUF-extra/a.gguf", dirs)).toBeNull();
  });
});

describe("suggestModelName", () => {
  it("仓库基名去掉 -GGUF 后缀、点转连字符、量化转小写", () => {
    expect(suggestModelName("unsloth/Qwen3.5-4B-GGUF", "Q4_K_M")).toBe("qwen3-5-4b-q4-k-m");
  });

  it("结果必须满足 modelSchema.name 的 /^[a-z0-9][a-z0-9-]*$/", () => {
    expect(suggestModelName("unsloth/Qwen3.5-4B-GGUF", "Q4_K_M")).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });

  it("量化为空时只取仓库基名", () => {
    expect(suggestModelName("unsloth/Qwen3.5-4B-GGUF", "")).toBe("qwen3-5-4b");
  });

  it("连续分隔符合并成一个连字符，不产生 --", () => {
    expect(suggestModelName("o/A__B..C-GGUF", "Q8_0")).toBe("a-b-c-q8-0");
  });
});

describe("suggestDisplayName", () => {
  it("保留原始大小写，量化放括号里", () => {
    expect(suggestDisplayName("unsloth/Qwen3.5-4B-GGUF", "Q4_K_M")).toBe("Qwen3.5-4B (Q4_K_M)");
  });

  it("量化为空时不带括号", () => {
    expect(suggestDisplayName("unsloth/Qwen3.5-4B-GGUF", "")).toBe("Qwen3.5-4B");
  });
});
