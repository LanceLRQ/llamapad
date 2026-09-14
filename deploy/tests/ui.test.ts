import { describe, expect, it } from "vitest";

import { sh } from "./sh";

describe("按键解析（ui_read_key）", () => {
  const key = (input: string) => sh("ui_read_key", { input }).stdout.trim();

  it("方向键（CSI 与 SS3 两种序列）", () => {
    expect(key("\x1b[A")).toBe("up");
    expect(key("\x1b[B")).toBe("down");
    expect(key("\x1b[C")).toBe("right");
    expect(key("\x1bOD")).toBe("left");
  });

  it("回车、退格、普通字符", () => {
    expect(key("\n")).toBe("enter");
    expect(key("\x7f")).toBe("backspace");
    expect(key("q")).toBe("char:q");
  });
});

describe("数字菜单模式（LLAMAPAD_PLAIN=1）", () => {
  it("ui_plain 在 LLAMAPAD_PLAIN=1 或 TERM=dumb 时为真", () => {
    expect(sh("ui_plain").code).toBe(0);
    expect(sh("ui_plain", { env: { LLAMAPAD_PLAIN: "", TERM: "dumb" } }).code).toBe(0);
  });

  it("ui_menu：输入序号得到 0 起的 UI_CHOICE；非法输入重问；q 返回 1；界面只写 stderr", () => {
    const pick = sh('ui_menu "Pick" A B C && printf %s "$UI_CHOICE"', { input: "2\n" });
    expect(pick.stdout).toBe("1");
    expect(pick.stderr).toContain("1) A");
    expect(sh('ui_menu "Pick" A B C && printf %s "$UI_CHOICE"', { input: "x\n9\n3\n" }).stdout).toBe("2");
    expect(sh('ui_menu "Pick" A B', { input: "q\n" }).code).toBe(1);
    expect(sh('ui_menu "Pick" A B', { input: "" }).code).toBe(1);
  });

  it("ui_input：回车取默认值，否则取输入", () => {
    expect(sh('ui_input "Port" 28960; printf %s "$UI_VALUE"', { input: "\n" }).stdout).toBe("28960");
    expect(sh('ui_input "Port" 28960; printf %s "$UI_VALUE"', { input: "30000\n" }).stdout).toBe("30000");
  });

  it("ui_password：读取整行", () => {
    expect(sh('ui_password "Pwd"; printf %s "$UI_VALUE"', { input: "a b$c\n" }).stdout).toBe("a b$c");
  });

  it("ui_confirm：空输入取默认；y/n 与中文是/否；其余重问", () => {
    expect(sh('ui_confirm "Go?" y', { input: "\n" }).code).toBe(0);
    expect(sh('ui_confirm "Go?" n', { input: "\n" }).code).toBe(1);
    expect(sh('ui_confirm "Go?" y', { input: "n\n" }).code).toBe(1);
    expect(sh('ui_confirm "Go?" n', { input: "maybe\n是\n" }).code).toBe(0);
  });
});
