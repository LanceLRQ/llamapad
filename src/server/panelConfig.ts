import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { panelSchema, type PanelConfig } from "@/core/schemas";

/**
 * 获取 panel.yaml 路径：优先读环境变量 PANEL_CONFIG，未设置时默认 <cwd>/config/panel.yaml。
 * 默认值经 process.cwd() 静态拼接（Next 产物追踪要求，避免动态相对路径触发全项目 trace）。
 */
export function getConfigPath(): string {
  return process.env.PANEL_CONFIG ?? path.join(process.cwd(), "config", "panel.yaml");
}

/** 模块级单例缓存（基础设施配置进程内不变，读一次即可；风格对齐 db.ts 的 getDb） */
let panelConfigInstance: PanelConfig | undefined;

/** models 宿主机根的来源，供 Doctor 展示与排障 */
export type ModelsHostSource = "env" | "file" | "discovered" | "unresolved";

/**
 * 自动发现结果挂 globalThis，不用模块级变量：Next 会把 page 与各 API route
 * 编译成独立 bundle，模块级变量互不共享（locators.ts 的 __llamapadRuntimeService
 * 等同款理由）——发现动作只在 instrumentation 的启动钩子里跑一次，若挂在模块级，
 * 其余 bundle 各自的模块实例永远看不到这次发现结果。
 */
const globalForDiscoveredHost = globalThis as typeof globalThis & {
  __llamapadDiscoveredModelsHost?: string;
};

/** 记录自动发现结果（启动钩子调用，见 src/instrumentation.ts） */
export function setDiscoveredModelsHost(hostPath: string): void {
  globalForDiscoveredHost.__llamapadDiscoveredModelsHost = hostPath;
}

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
  delete globalForDiscoveredHost.__llamapadDiscoveredModelsHost;
}

export type { PanelConfig };

/** 环境变量非空串才算"已设置"，口径对齐 panel.yaml 的 min(1) 校验，避免空字符串被当成有效配置 */
function envModelsHost(): string | undefined {
  const value = process.env.PANEL_MODELS_HOST;
  return value !== undefined && value.trim() !== "" ? value : undefined;
}

/**
 * 解析后的 models 宿主机根。优先级：
 * PANEL_MODELS_HOST 环境变量 > panel.yaml 的 paths.models.host > 自动发现结果 > 未解析（空串）
 */
export function getModelsHost(): string {
  return (
    envModelsHost() ??
    getPanelConfig().paths.models.host ??
    globalForDiscoveredHost.__llamapadDiscoveredModelsHost ??
    ""
  );
}

/** 当前 host 值来自哪一级，供 Doctor 展示与排障 */
export function getModelsHostSource(): ModelsHostSource {
  if (envModelsHost() !== undefined) return "env";
  if (getPanelConfig().paths.models.host !== undefined) return "file";
  if (globalForDiscoveredHost.__llamapadDiscoveredModelsHost !== undefined) return "discovered";
  return "unresolved";
}
