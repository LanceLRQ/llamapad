import { describe, expect, it } from "vitest";

import { classifyLoginError } from "./login-error";

describe("classifyLoginError", () => {
  it("登录态密码错误（401）判为字段级", () => {
    expect(classifyLoginError("login", 401)).toBe("field");
  });

  it("登录态其它失败（403/500）判为整块级", () => {
    expect(classifyLoginError("login", 403)).toBe("block");
    expect(classifyLoginError("login", 500)).toBe("block");
  });

  it("首启态不校验旧密码，401 也判为整块级", () => {
    expect(classifyLoginError("setup", 401)).toBe("block");
  });

  it("首启态管理员已存在（403）判为整块级", () => {
    expect(classifyLoginError("setup", 403)).toBe("block");
  });
});
