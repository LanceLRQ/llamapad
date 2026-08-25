/**
 * 复制文本到剪贴板（供「签发后明文只显示一次」的一次性复制）。
 *
 * 优先 Async Clipboard API——但它仅在安全上下文（HTTPS/localhost）可用，而面板
 * 主部署形态是 HTTP 局域网访问：Chrome/Safari 下 navigator.clipboard 为 undefined，
 * Firefox 下 writeText 会 reject。故 clipboard 不可用或失败时回退隐藏 textarea +
 * document.execCommand("copy")（已废弃但各主流浏览器仍支持，不受安全上下文限制）。
 *
 * 两条路都失败返回 false——调用方必须据此给用户可见的失败反馈，绝不静默
 * （明文 token 被 truncate 展示，用户手动选区可能不完整，误以为已复制会粘出难排查的 401）。
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // 落入 execCommand 回退
    }
  }
  if (typeof document === "undefined") return false;

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  // fixed + 透明：避开视口外/隐藏导致的选区失效，同时不在页面上闪现
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  textarea.remove();
  return ok;
}
