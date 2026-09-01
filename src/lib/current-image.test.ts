import { describe, expect, it } from "vitest";

import { findLocalImage, isCurrentImageSavable, type LocalImageLike } from "./current-image";

/**
 * 「当前启动镜像」读数卡的判定层。
 * 重点是 findLocalImage 必须精确匹配 tag：docker 的 ref 是 `repo:tag` 字面量，
 * 任何前缀/模糊匹配都会把 foo:12 误报成 foo:1 已拉取。
 */

const LOCAL: LocalImageLike[] = [
  { tags: ["ghcr.io/ggml-org/llama.cpp:server-cuda"], size: 5_600_000_000 },
  { tags: ["alpine:latest", "alpine:3.20"], size: 7_800_000 },
];

describe("findLocalImage", () => {
  it("命中时返回体积", () => {
    expect(findLocalImage("ghcr.io/ggml-org/llama.cpp:server-cuda", LOCAL)).toEqual({
      sizeBytes: 5_600_000_000,
    });
  });

  it("同一镜像的多个 tag 都能命中", () => {
    expect(findLocalImage("alpine:3.20", LOCAL)).toEqual({ sizeBytes: 7_800_000 });
  });

  it("未命中返回 null", () => {
    expect(findLocalImage("nope:latest", LOCAL)).toBeNull();
  });

  it("前缀相同但 tag 不同不算命中（alpine:3 不等于 alpine:3.20）", () => {
    expect(findLocalImage("alpine:3", LOCAL)).toBeNull();
  });

  it("ref 首尾空白不影响匹配", () => {
    expect(findLocalImage("  alpine:latest  ", LOCAL)).toEqual({ sizeBytes: 7_800_000 });
  });

  it("空 ref 直接返回 null，不去匹配", () => {
    expect(findLocalImage("   ", LOCAL)).toBeNull();
  });

  it("本地列表为空时返回 null", () => {
    expect(findLocalImage("alpine:latest", [])).toBeNull();
  });
});

describe("isCurrentImageSavable", () => {
  it("与已保存值不同且非空时可保存", () => {
    expect(isCurrentImageSavable("alpine:latest", "ghcr.io/x:1")).toBe(true);
  });

  it("与已保存值相同时不可保存", () => {
    expect(isCurrentImageSavable("alpine:latest", "alpine:latest")).toBe(false);
  });

  it("仅首尾空白之差不算改动——保存下去的也是 trim 后的值，亮起来等于承诺一次什么都不变的写入", () => {
    expect(isCurrentImageSavable("  alpine:latest  ", "alpine:latest")).toBe(false);
  });

  it("清空不可保存（schema 是 z.string().min(1)）", () => {
    expect(isCurrentImageSavable("", "alpine:latest")).toBe(false);
  });

  it("只剩空白也不可保存", () => {
    expect(isCurrentImageSavable("   ", "alpine:latest")).toBe(false);
  });
});
