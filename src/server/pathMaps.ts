import { getPanelConfig } from "./panelConfig";
import { toHostPath, toPanelPath, type PathMap } from "@/core/paths";

/**
 * 换算纯函数的 server 薄封装（M1 Task 2）：从 panel.yaml 单例取映射表。
 * 逻辑全部在 core/paths.ts，本文件不做单测；后续 panel.yaml 增加
 * config 等映射组时，只需在 getPathMaps 的数组里补一项。
 */

/** 当前生效的路径映射表（现仅 models 一组，按数组形态通用化） */
export function getPathMaps(): PathMap[] {
  const c = getPanelConfig();
  return [{ host: c.paths.models.host, panel: c.paths.models.panel }];
}

/** panel 视角 → host 视角（docker bind / 宿主机落盘用） */
export function toHost(panelPath: string): string {
  return toHostPath(getPathMaps(), panelPath);
}

/** host 视角 → panel 视角（面板容器内 fs 操作用） */
export function toPanel(hostPath: string): string {
  return toPanelPath(getPathMaps(), hostPath);
}
