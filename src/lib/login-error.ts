/**
 * 登录/首启提交失败后，响应该以哪种视觉重量呈现：
 * - "field"：单字段问题，输入框描红 + 一行小字。目前只有「登录密码错误」落在这一档——
 *   /api/v1/auth/login 密码错误时返回 401；/api/v1/auth/setup 不校验旧密码，不会产生这个状态。
 * - "block"：其它失败（管理员已存在、请求失败、网络错误等），走整块警告，不升级/降级。
 */
export function classifyLoginError(mode: "login" | "setup", status: number): "field" | "block" {
  return mode === "login" && status === 401 ? "field" : "block";
}
