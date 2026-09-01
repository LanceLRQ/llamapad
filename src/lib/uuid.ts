/**
 * 生成一枚随机 id（客户端专用，用于 Webhook 渠道等本地草稿行的临时标识）。
 *
 * crypto.randomUUID 只在安全上下文（HTTPS / localhost）暴露，而面板真机部署
 * 是局域网 IP + HTTP——直接调用会抛 TypeError，且项目原本没有任何 error.tsx
 * 兜底，整页会被 Next 内置错误页接管（真机复现为「添加渠道」白屏）。
 * getRandomValues 不受安全上下文限制，是这里最可靠的一档；两者都缺席（极老
 * 浏览器或测试环境裁剪过 crypto）时落到 Math.random，格式仍合法但不具密码学
 * 强度——这里只用来做本地草稿行的 React key/id，不涉及任何安全用途。
 */
export function randomId(): string {
  const c = typeof crypto !== "undefined" ? crypto : undefined;

  if (typeof c?.randomUUID === "function") {
    return c.randomUUID();
  }

  if (typeof c?.getRandomValues === "function") {
    const bytes = c.getRandomValues(new Uint8Array(16));
    return bytesToV4(bytes);
  }

  const bytes = new Uint8Array(16);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return bytesToV4(bytes);
}

/** 按 RFC 4122 v4 规则强制版本/变体位，再拼成标准分段十六进制字符串 */
function bytesToV4(bytes: Uint8Array): string {
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // 版本位固定为 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // 变体位固定为 10xxxxxx

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
