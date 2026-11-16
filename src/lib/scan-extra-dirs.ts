/**
 * 档案详情页「扫描」自定义目录输入框的解析（本地权重迁移批③任务 15）。
 *
 * 手填路径用逗号分隔，点选的路径必要时加引号，保留目录名里的逗号。
 *
 * 输入框由 SSR 取到的已持久化目录回填，档案页每次扫描都把结果**原样发出去**
 * （空数组即「清除自定义目录」）——它是当前生效范围的可编辑视图，不是一个每次
 * 从空白开始的追加框。此前调用方按「数组非空才发这个键」处理，服务端不带该键
 * 时会退回已持久化的值，于是清空输入框根本删不掉已配置的目录。
 */
export function parseScanExtraDirs(text: string): string[] {
  return Array.from(
    text.matchAll(/\s*(?:"((?:[^"]|"")*)"\s*(?=,|$)|([^,]*))(?:,|$)/g),
    ([, quoted, plain]) => quoted !== undefined ? quoted.replaceAll('""', '"') : plain.trim(),
  ).filter(Boolean);
}

export function formatScanExtraDirs(dirs: readonly string[]): string {
  return dirs.map((dir) => /[,"]/.test(dir) || dir !== dir.trim()
    ? `"${dir.replaceAll('"', '""')}"`
    : dir,
  ).join(", ");
}
