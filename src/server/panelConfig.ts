import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { panelSchema, type PanelConfig } from "@/core/schemas";

/**
 * 获取 panel.yaml 路径：优先读环境变量 PANEL_CONFIG，未设置时默认 config/panel.yaml（相对 cwd）。
 */
export function getConfigPath(): string {
  return process.env.PANEL_CONFIG ?? "config/panel.yaml";
}

/** 模块级单例缓存（基础设施配置进程内不变，读一次即可；风格对齐 db.ts 的 getDb） */
let panelConfigInstance: PanelConfig | undefined;

/**
 * 惰性单例：读取并校验 panel.yaml（基础设施配置：路径映射/代理/监听）。
 * - 文件不存在：视为未配置，返回 schema 默认值（面板起不来时也能按约定目录引导）
 * - 文件存在：YAML.parse + panelSchema.safeParse；失败时抛 Error，
 *   message 指名到哪个文件哪个字段（设计 §11），便于人工诊断
 */
export function getPanelConfig(): PanelConfig {
  if (panelConfigInstance) {
    return panelConfigInstance;
  }

  const file = getConfigPath();
  if (!existsSync(file)) {
    panelConfigInstance = panelSchema.parse({});
    return panelConfigInstance;
  }

  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`解析 ${file} 失败: ${e instanceof Error ? e.message : String(e)}`);
  }

  const result = panelSchema.safeParse(raw);
  if (!result.success) {
    // 错误拼接惯例与 auth.ts / repo/models.ts 一致（zod 4：issue.path.join(".")）
    const detail = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`panel.yaml 校验失败(${file}): ${detail}`);
  }

  panelConfigInstance = result.data;
  return panelConfigInstance;
}

/** 仅测试用：清空单例缓存，保证用例间隔离（名字带下划线表明非生产 API） */
export function _resetPanelConfigForTest(): void {
  panelConfigInstance = undefined;
}

export type { PanelConfig };
