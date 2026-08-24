import { normalize, sep } from "node:path";

/**
 * 路径视角换算纯函数（M1 Task 2）
 *
 * 三视角约定：面板容器的文件系统与宿主机不同，同名目录在两侧路径不一致——
 * - 配置相对路径：models 表中的 gguf_file 等，相对 models 根（如 main/a.gguf）
 * - panel 视角：面板容器内的绝对路径，用于面板自身的 fs 操作（如 /mnt/models/main/a.gguf）
 * - host 视角：宿主机绝对路径，用于 docker bind / 下载落盘（如 /srv/llama/models/main/a.gguf）
 * 任何视角间的换算只允许经过本模块，禁止散落各处的字符串 replace 拼接。
 *
 * 匹配算法（对每个 map 判断输入是否位于其 panel/host 根「之内」）：
 * - 目录边界：相等，或输入以 root+sep 开头——纯字符串前缀不算（防 /models
 *   与 /models2 误匹配，也使 host/panel 字段写反时自然失配）
 * - 最长前缀：多个 map 同时命中时取根最长者（嵌套挂载时内层优先）
 * - 归一化：输入与根都先经 path.normalize（消解 //、./、../，保持绝对路径）
 *
 * 错误契约与 config.ts 一致：抛普通 Error，message 自行拼接——
 * 越界含「路径在映射之外」与原路径；映射表为空含 panel.yaml 排查引导文案。
 */

/** 一组 host ↔ panel 路径映射（panel.yaml paths 的通用化形态，现为 models 一组） */
export interface PathMap {
  host: string;
  panel: string;
}

/** 判断 path 是否位于 root 之内（相等，或以 root+目录分隔符 开头） */
function isInside(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * 通用换算：side 是输入所在的视角（"panel" 或 "host"），对侧为输出视角。
 * 命中的 map 中取根最长者，输出 = 对侧根 + 输入截掉本侧根后的余部。
 */
function convert(maps: PathMap[], input: string, side: "panel" | "host"): string {
  if (maps.length === 0) {
    throw new Error(
      `路径映射表为空，无法换算 "${input}"；请检查 panel.yaml 路径映射（paths）与容器挂载是否一致`,
    );
  }

  const p = normalize(input);
  let best: { root: string; target: string } | undefined;
  for (const map of maps) {
    const root = normalize(map[side]);
    if (isInside(root, p)) {
      const target = normalize(side === "panel" ? map.host : map.panel);
      if (best === undefined || root.length > best.root.length) {
        best = { root, target };
      }
    }
  }

  if (best === undefined) {
    throw new Error(`路径在映射之外: "${input}"（${side} 视角）`);
  }

  // 余部：根不以 sep 结尾时 slice 自带前导 sep；根恰为 "/"（唯一以 sep 结尾的
  // normalize 结果）时补一个，保证拼接处有目录边界；最后 normalize 清理 target 为 "/" 的拼接
  const rel = best.root.endsWith(sep) ? sep + p.slice(best.root.length) : p.slice(best.root.length);
  return normalize(best.target + rel);
}

/** panel 视角 → host 视角（docker bind / 宿主机落盘用） */
export function toHostPath(maps: PathMap[], panelPath: string): string {
  return convert(maps, panelPath, "panel");
}

/** host 视角 → panel 视角（面板容器内 fs 操作用） */
export function toPanelPath(maps: PathMap[], hostPath: string): string {
  return convert(maps, hostPath, "host");
}
