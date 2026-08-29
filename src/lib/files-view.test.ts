import { describe, expect, it } from "vitest";

import { FILES_VIEW_ALL_KEY, FILES_VIEW_META_KEY, resolveFilesView } from "./files-view";

describe("resolveFilesView", () => {
  const namespaces = ["embedding", "main", "vision"];

  it("raw 为 undefined 时落到 all 视图", () => {
    expect(resolveFilesView(undefined, namespaces)).toEqual({ kind: "all" });
  });

  it("raw 字面量 all 落到 all 视图", () => {
    expect(resolveFilesView(FILES_VIEW_ALL_KEY, namespaces)).toEqual({ kind: "all" });
  });

  it("raw 命中真实命名空间时落到 namespace 视图", () => {
    expect(resolveFilesView("main", namespaces)).toEqual({ kind: "namespace", namespace: "main" });
  });

  it("raw 为 @meta 时落到 meta 视图", () => {
    expect(resolveFilesView(FILES_VIEW_META_KEY, namespaces)).toEqual({ kind: "meta" });
  });

  it("拼错的/已删除的空间名落到 all 视图", () => {
    expect(resolveFilesView("does-not-exist", namespaces)).toEqual({ kind: "all" });
  });

  it("命名空间恰好叫 all 时优先命中命名空间分支，而非 all 键", () => {
    expect(resolveFilesView("all", ["all", "main"])).toEqual({ kind: "namespace", namespace: "all" });
  });

  it("命名空间恰好叫 meta 时，@meta 仍落到 meta 视图（@ 不在命名空间字符集里）", () => {
    // namespaceSchema 只允许 [a-z0-9][a-z0-9-]*，"@" 永远不会出现在合法命名空间里，
    // 所以一个叫 "meta" 的命名空间不会、也不可能遮住 "@meta" 这个键。
    expect(resolveFilesView(FILES_VIEW_META_KEY, ["meta", "main"])).toEqual({ kind: "meta" });
    // 而命名空间本身叫 "meta"（合法，不含 @）时，走的是普通命名空间分支
    expect(resolveFilesView("meta", ["meta", "main"])).toEqual({ kind: "namespace", namespace: "meta" });
  });
});
