import { readdirSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";

/**
 * models 目录树扫描与模型文件解析（M1 Task 3，panel 视角 fs 操作）
 *
 * 目录形态约定：models 树只有两层 <ns>/<file>（设计约定：命名空间内不嵌套
 * 子目录）。glob 解析据此把 pattern 按 "/" 拆成 ns 段 + 文件段分别匹配；
 * 段内文件名不含 "/"，故更深的 pattern（如 main/sub/*.gguf）自然零命中。
 *
 * glob 方言（两层树够用即可，不引第三方依赖）：
 * - `*` → [^/]*（段内任意、不跨 /）；`?` → [^/]（单字符）；其余字符字面量转义
 * - 不支持 ** / [] / {}（两层结构用不到）
 *
 * 通用约定：
 * - 隐藏文件/目录（. 开头，如 .DS_Store）在 glob 匹配与目录扫描中一律跳过
 *   （精确路径不跳过——显式配置的路径按字面解析）
 * - rel 一律为相对 modelsRoot 的路径（ns 与文件名之间用 / 连接）
 * - 安全：relPath 任一路径段为 ".." 时抛 Error，防逃逸 models 根
 *   （glob 形式的逃逸同样在匹配前拦截）
 */

/** models 树中的一个文件：rel 相对根、size 字节、mtime 毫秒 */
export interface ModelFile {
  rel: string;
  size: number;
  mtime: number;
}

/** resolveModelFiles 结果：命中文件列表 + 是否缺失（精确不存在 / glob 零命中） */
export interface ResolvedModelFiles {
  files: ModelFile[];
  missing: boolean;
}

/** scanTree 结果：一个命名空间（models 一级目录）与其直接文件 */
export interface NamespaceFiles {
  namespace: string;
  files: ModelFile[];
}

/** glob 段 → 锚定正则：* → [^/]*、? → [^/]，其余字符按字面量转义 */
function globSegmentToRegExp(segment: string): RegExp {
  let source = "";
  for (const ch of segment) {
    if (ch === "*") source += "[^/]*";
    else if (ch === "?") source += "[^/]";
    else if (/[.*+?^${}()|[\]\\]/.test(ch)) source += `\\${ch}`;
    else source += ch;
  }
  return new RegExp(`^${source}$`);
}

function isHidden(name: string): boolean {
  return name.startsWith(".");
}

/** 判断 errno 是否"不存在"（ENOENT）；其他错误原样抛出 */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** stat 单个文件取 size/mtime；非普通文件（目录等）返回 null（跟随符号链接） */
function statFile(abs: string): { size: number; mtime: number } | null {
  const st = statSync(abs);
  return st.isFile() ? { size: st.size, mtime: st.mtimeMs } : null;
}

/** 按相对路径排序（code-unit 字典序，跨平台确定） */
function byRel(a: ModelFile, b: ModelFile): number {
  return a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0;
}

/**
 * 按配置中的 gguf 路径解析实际文件列表。
 * - 精确路径（无 * / ?）：存在 → 单元素；不存在 → missing
 * - glob 路径：两层匹配后按文件名（rel）排序返回；零命中 → missing
 * - relPath 任一段为 ".." → 抛 Error
 */
export function resolveModelFiles(modelsRoot: string, relPath: string): ResolvedModelFiles {
  const segments = relPath.split("/");
  if (segments.includes("..")) {
    throw new Error(`gguf 路径不允许包含 ..（防逃逸 models 根）: ${relPath}`);
  }

  // ---------- 精确路径 ----------
  if (!relPath.includes("*") && !relPath.includes("?")) {
    const abs = join(modelsRoot, ...segments);
    let meta: { size: number; mtime: number } | null;
    try {
      meta = statFile(abs);
    } catch (error) {
      if (isENOENT(error)) return { files: [], missing: true };
      throw error;
    }
    if (meta === null) return { files: [], missing: true };
    return { files: [{ rel: relPath, ...meta }], missing: false };
  }

  // ---------- glob：拆 ns 段 + 文件段（单段 pattern 视为匹配根下直接文件） ----------
  const nsSegment = segments.length > 1 ? segments[0] : "";
  const fileSegment = segments.length > 1 ? segments.slice(1).join("/") : segments[0];
  const nsRe = globSegmentToRegExp(nsSegment);
  const fileRe = globSegmentToRegExp(fileSegment);

  let rootEntries: Dirent[];
  try {
    rootEntries = readdirSync(modelsRoot, { withFileTypes: true });
  } catch (error) {
    if (isENOENT(error)) return { files: [], missing: true };
    throw error;
  }

  const files: ModelFile[] = [];
  if (nsSegment === "") {
    for (const entry of rootEntries) {
      if (isHidden(entry.name)) continue;
      const meta = statFile(join(modelsRoot, entry.name));
      if (meta !== null && fileRe.test(entry.name)) {
        files.push({ rel: entry.name, ...meta });
      }
    }
  } else {
    for (const entry of rootEntries) {
      if (!entry.isDirectory() || isHidden(entry.name) || !nsRe.test(entry.name)) continue;
      const nsDir = join(modelsRoot, entry.name);
      for (const name of readdirSync(nsDir)) {
        if (isHidden(name)) continue;
        const meta = statFile(join(nsDir, name));
        if (meta !== null && fileRe.test(name)) {
          files.push({ rel: `${entry.name}/${name}`, ...meta });
        }
      }
    }
  }

  files.sort(byRel);
  return { files, missing: files.length === 0 };
}

/**
 * 扫描 models 目录树：每个一级目录（命名空间）下的直接文件（平铺不嵌套，
 * ns 内子目录跳过且其内部不扫；根下散落文件不属于任何命名空间）。
 * - 跳过隐藏目录与隐藏文件（. 开头）
 * - modelsRoot 不存在 → 空数组（不抛）；其他 fs 错误原样抛出
 * - 结果按 namespace 排序，files 按文件名排序
 */
export function scanTree(modelsRoot: string): NamespaceFiles[] {
  let rootEntries: Dirent[];
  try {
    rootEntries = readdirSync(modelsRoot, { withFileTypes: true });
  } catch (error) {
    if (isENOENT(error)) return [];
    throw error;
  }

  const namespaces = rootEntries
    .filter((e) => e.isDirectory() && !isHidden(e.name))
    .map((e) => e.name)
    .sort();

  return namespaces.map((namespace) => {
    const nsDir = join(modelsRoot, namespace);
    const files: ModelFile[] = [];
    for (const name of readdirSync(nsDir)) {
      if (isHidden(name)) continue;
      const meta = statFile(join(nsDir, name));
      if (meta !== null) files.push({ rel: `${namespace}/${name}`, ...meta });
    }
    files.sort(byRel);
    return { namespace, files };
  });
}
