import { readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { toPanelPath, type PathMap } from "@/core/paths";

function contains(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** 无路径时列出挂载根，有路径时只读该目录的下一级。输出始终是宿主机路径。 */
export async function listScanDirectories(maps: readonly PathMap[], path: string | null): Promise<string[] | null> {
  const mounts = maps
    .filter(({ host, panel }) => isAbsolute(host) && isAbsolute(panel))
    .map(({ host, panel }) => ({ host: resolve(host), panel: resolve(panel) }));

  if (path === null) {
    const roots = await Promise.all(mounts.map(async ({ host, panel }) => {
      const info = await stat(panel).catch(() => null);
      return info?.isDirectory() ? host : null;
    }));
    return [...new Set(roots.filter((root) => root !== null))];
  }

  if (!isAbsolute(path)) return null;
  const hostPath = resolve(path);
  const mount = mounts
    .filter(({ host }) => contains(host, hostPath))
    .sort((a, b) => b.host.length - a.host.length)[0];
  if (mount === undefined || relative(mount.host, hostPath).split(sep).some((part) => part.startsWith("."))) {
    return null;
  }

  const [root, dir] = await Promise.all([
    realpath(mount.panel).catch(() => null),
    realpath(toPanelPath([mount], hostPath)).catch(() => null),
  ]);
  if (root === null || dir === null || !contains(root, dir)) return null;

  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (entries === null) return null;
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => join(hostPath, entry.name))
    .sort();
}
