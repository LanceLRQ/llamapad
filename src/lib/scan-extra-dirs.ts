/**
 * 档案详情页「扫描」自定义目录输入框的解析（本地权重迁移批③任务 15）。
 *
 * 输入框是逗号分隔的宿主机路径文本，留空即沿用服务端已持久化的默认范围
 * （`POST /repos/:id/scan` 的 body 不带 `extraDirs` 时退回 `getConfiguredScanDirs`，
 * 见该路由头注释）——因此这里只负责「文本 → 去空白去空项的数组」，是否要把
 * 空数组发给服务端由调用方按数组是否为空决定，本函数不掺和那个判断。
 */
export function parseScanExtraDirs(text: string): string[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
