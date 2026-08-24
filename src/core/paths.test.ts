import { describe, expect, it } from "vitest";
import { toHostPath, toPanelPath, type PathMap } from "./paths";

/**
 * 测试自有的映射样例（与 panel.yaml 默认值相互独立，避免用实现产物断言实现）。
 * 约定：panel 视角 /mnt/models ↔ host 视角 /srv/llama/models。
 */
const MODELS: PathMap[] = [{ host: "/srv/llama/models", panel: "/mnt/models" }];

describe("toHostPath / toPanelPath", () => {
  it("基本换算：panel 子路径 → host 子路径，反向同理", () => {
    expect(toHostPath(MODELS, "/mnt/models/main/a.gguf")).toBe("/srv/llama/models/main/a.gguf");
    expect(toPanelPath(MODELS, "/srv/llama/models/main/a.gguf")).toBe("/mnt/models/main/a.gguf");
  });

  it("映射根本身：panelPath 正好等于映射根时换算为对侧根，不抛错", () => {
    expect(toHostPath(MODELS, "/mnt/models")).toBe("/srv/llama/models");
    expect(toPanelPath(MODELS, "/srv/llama/models")).toBe("/mnt/models");
  });

  it("前缀必须是目录边界：/mnt/models2 是 /mnt/models 的字符串前缀但不是子路径 → 抛错", () => {
    expect(() => toHostPath(MODELS, "/mnt/models2/x.gguf")).toThrow(/路径在映射之外/);
    // host 侧同理：/srv/llama/models2 不应命中 /srv/llama/models
    expect(() => toPanelPath(MODELS, "/srv/llama/models2/x.gguf")).toThrow(/路径在映射之外/);
  });

  it("越界路径抛 Error，message 含「路径在映射之外」与原路径", () => {
    expect(() => toHostPath(MODELS, "/etc/passwd")).toThrow(/路径在映射之外/);
    expect(() => toHostPath(MODELS, "/etc/passwd")).toThrow(/\/etc\/passwd/);
    expect(() => toPanelPath(MODELS, "/etc/passwd")).toThrow(/路径在映射之外/);
    expect(() => toPanelPath(MODELS, "/etc/passwd")).toThrow(/\/etc\/passwd/);
  });

  it("空映射表：任何路径抛错，message 含排查引导文案", () => {
    expect(() => toHostPath([], "/mnt/models/a.gguf")).toThrow(
      /检查 panel\.yaml 路径映射（paths）与容器挂载是否一致/,
    );
    expect(() => toPanelPath([], "/srv/llama/models/a.gguf")).toThrow(
      /检查 panel\.yaml 路径映射（paths）与容器挂载是否一致/,
    );
  });

  it("多映射最长前缀：/m/ab/f 命中第二条（panel 根 /m/ab 更长），/m/a/f 命中第一条", () => {
    const maps: PathMap[] = [
      { host: "/a", panel: "/m/a" },
      { host: "/a/b", panel: "/m/ab" },
    ];
    expect(toHostPath(maps, "/m/ab/f")).toBe("/a/b/f");
    expect(toHostPath(maps, "/m/a/f")).toBe("/a/f");
  });

  it("嵌套根同样取最长：同时位于 /m 与 /m/b 之内时命中更长的 /m/b", () => {
    const maps: PathMap[] = [
      { host: "/a", panel: "/m" },
      { host: "/a/b", panel: "/m/b" },
    ];
    expect(toHostPath(maps, "/m/b/f.gguf")).toBe("/a/b/f.gguf");
    expect(toHostPath(maps, "/m/x.gguf")).toBe("/a/x.gguf");
  });

  it("归一化：多余的 / 与 ../ 片段先归一化再匹配，结果与干净路径一致", () => {
    expect(toHostPath(MODELS, "/mnt/models//main/../main/a.gguf")).toBe(
      "/srv/llama/models/main/a.gguf",
    );
    expect(toPanelPath(MODELS, "/srv/llama/models/./main/a.gguf")).toBe(
      "/mnt/models/main/a.gguf",
    );
  });

  it("两侧字段写反（host 值出现在 panel 端）能被前缀规则自然拒绝", () => {
    const swapped: PathMap[] = [{ host: "/mnt/models", panel: "/srv/llama/models" }];
    expect(() => toHostPath(swapped, "/mnt/models/main/a.gguf")).toThrow(/路径在映射之外/);
  });
});
