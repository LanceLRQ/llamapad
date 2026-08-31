/**
 * URL 直链兜底文件名推导（M2 修复）：从 `downloads/direct` route 原地写的
 * 逻辑下沉。原实现两处问题——`new URL(u).pathname` 至少是 `"/"`，
 * `"/".split("/")` 得到 `["", ""]`，`.pop()` 拿到 `""` 而不是 `undefined`，
 * `?? "download.gguf"` 因此是永远走不到的死分支；`decodeURIComponent` 在
 * try 块之外，畸形百分号转义会直接抛 `URIError` 冒泡成 500 而非该有的 400。
 */

/**
 * 取 URL 路径里最后一个非空段并尝试解码；解码失败（畸形转义）回落原始段；
 * 一个非空段都没有（如根路径 `https://x.com/`）才回落 `"download.gguf"`。
 */
export function filenameFromUrl(url: string): string {
  const segments = new URL(url).pathname.split("/").filter((s) => s !== "");
  const last = segments.at(-1);
  if (last === undefined) return "download.gguf";
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}
