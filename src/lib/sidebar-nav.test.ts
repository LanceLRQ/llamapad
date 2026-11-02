import { describe, expect, it } from "vitest";
import { sidebarChildren } from "./sidebar-nav";

describe("sidebarChildren", () => {
  it.each([
    ["/models", "home"],
    ["/models/repos", "repos"],
    ["/models/repos/12", "repos"],
    ["/models/profiles", "configs"],
    ["/models/new", "configs"],
    ["/models/test/edit", "configs"],
    ["/models/test/duplicate", "configs"],
  ])("模型路径 %s 选中 %s", (pathname, key) => {
    expect(sidebarChildren("models", pathname, "").filter((item) => item.active).map((item) => item.key)).toEqual([key]);
  });

  it("其他模块不选中模型子项，也不继承无关 query", () => {
    const items = sidebarChildren("models", "/settings", "tab=account");
    expect(items.every((item) => !item.active && !item.href.includes("?"))).toBe(true);
  });

  it.each(["runtime", "library", "monitor", "account"])("设置 %s 选中且保留其他参数", (key) => {
    const items = sidebarChildren("settings", "/settings", `tab=${key}&import=example`);
    expect(items.find((item) => item.active)?.key).toBe(key);
    expect(items.every((item) => item.href.includes("import=example"))).toBe(true);
  });

  it("设置缺省或非法值均选择运行环境", () => {
    for (const search of ["", "tab=unknown"]) {
      expect(sidebarChildren("settings", "/settings", search).find((item) => item.active)?.key).toBe("runtime");
    }
  });

  it.each(["queue", "downloading", "pending", "paused", "failed", "history"])("保留下载 %s 入口和筛选", (key) => {
    const items = sidebarChildren("downloads", "/downloads", `view=${key}&q=test`);
    expect(items).toHaveLength(6);
    expect(items.find((item) => item.active)?.key).toBe(key);
    expect(items.every((item) => item.href.includes("q=test"))).toBe(true);
  });

  it("非法下载视图回退队列", () => {
    expect(sidebarChildren("downloads", "/downloads", "view=unknown").find((item) => item.active)?.key).toBe("queue");
  });

  it("切换日志视图保留选中的模型", () => {
    const items = sidebarChildren("logs", "/logs", "tab=logs&model=example");
    expect(items.find((item) => item.active)?.key).toBe("logs");
    expect(items.find((item) => item.key === "history")?.href).toBe("/logs?tab=history&model=example");
  });

  it("未激活模块使用自己的缺省 query，不复制当前页参数", () => {
    expect(sidebarChildren("settings", "/logs", "model=example")[0]).toMatchObject({ href: "/settings?tab=runtime", active: false });
  });
});
