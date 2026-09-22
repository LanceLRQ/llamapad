/**
 * 页头模型选择器的判定（多模型并行：Chat 页与日志页，决策 D11 / D12）。
 * 组件在 node 环境的 vitest 里测不了，选中哪个、列哪些、何时显示都收在这里。
 */
import { orderForModelsList } from "./models-list";

/** 下拉框需要的运行中模型字段（RunningModelView 的子集） */
export interface RunningModelSummary {
  model: string;
  displayName: string;
  /** llama-server 是否已就绪；false 时选项标「加载中」 */
  ready: boolean;
}

export interface ModelPickerOption {
  /** Select 的值：模型名 */
  value: string;
  label: string;
  isDefault: boolean;
  /** 容器在跑但 llama-server 还没就绪 */
  loading: boolean;
  /** 选中的模型已不在运行列表：仍保留一项，下拉框不会显示空白 */
  stopped: boolean;
}

/**
 * 日志页「跟随默认模型」选项的值。模型名只允许小写字母、数字与连字符
 * （core/schemas.ts），不会与它撞上
 */
export const FOLLOW_DEFAULT = "__default__";

/** URL 查询参数里的模型名：缺省、空白 → null；重复参数取第一个 */
export function parseModelParam(raw: string | string[] | undefined): string | null {
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? "";
  return value === "" ? null : value;
}

export interface ChatModelChoice {
  /** 本页对话的模型；没有模型在跑时为 null */
  model: string | null;
  /** 请求的模型没在跑、改用了别的模型时，为请求的模型名（页面据此给提示）；否则 null */
  fellBackFrom: string | null;
}

/**
 * Chat 页选哪个模型：请求的模型在跑就用它，否则用默认模型。默认模型为空或不在列表
 * （状态刚变化的窗口）时取第一个在跑的，与 runtime 的默认模型决议同一口径（最早启动）。
 */
export function resolveChatModel(
  models: readonly { model: string }[],
  defaultModel: string | null,
  requested: string | null,
): ChatModelChoice {
  if (requested !== null && models.some((entry) => entry.model === requested)) {
    return { model: requested, fellBackFrom: null };
  }
  const model = models.find((entry) => entry.model === defaultModel)?.model ?? models[0]?.model ?? null;
  return { model, fellBackFrom: requested !== null && model !== null ? requested : null };
}

/** 下拉选项：默认模型排第一（与 /v1/models 同序）；选中的模型已停止时末尾补一项 */
export function buildModelOptions(
  models: readonly RunningModelSummary[],
  defaultModel: string | null,
  selected: string | null,
): ModelPickerOption[] {
  const options = orderForModelsList(models, defaultModel).map((entry) => ({
    value: entry.model,
    label: entry.displayName,
    isDefault: entry.model === defaultModel,
    loading: !entry.ready,
    stopped: false,
  }));
  if (selected !== null && selected !== FOLLOW_DEFAULT && !models.some((entry) => entry.model === selected)) {
    options.push({ value: selected, label: selected, isDefault: false, loading: false, stopped: true });
  }
  return options;
}

/** 选中的模型是否已不在运行列表（没选时恒 false） */
export function isSelectionGone(selected: string | null, models: readonly { model: string }[]): boolean {
  return selected !== null && !models.some((entry) => entry.model === selected);
}

/**
 * 日志页是否显示下拉框：多个模型在跑时显示；已经固定了某个模型时也显示，
 * 哪怕它已经停了，否则用户没有入口切回「跟随默认模型」
 */
export function showLogsPicker(runningCount: number, selected: string | null): boolean {
  return runningCount > 1 || selected !== null;
}

/** 只挑下拉框用的字段：server 组件把它作为初值传给 client 组件，多余字段不进序列化 */
export function summarizeRunningModels(models: readonly RunningModelSummary[]): RunningModelSummary[] {
  return models.map(({ model, displayName, ready }) => ({ model, displayName, ready }));
}

/** 容器日志流地址：跟随默认模型时不带参数 */
export function logsStreamUrl(model: string | null): string {
  return model === null ? "/api/v1/logs/stream" : `/api/v1/logs/stream?model=${encodeURIComponent(model)}`;
}

export function chatHref(model: string): string {
  return `/chat?model=${encodeURIComponent(model)}`;
}

/** 日志页容器日志组的地址：跟随默认模型时不带 model */
export function logsHref(model: string | null): string {
  return model === null ? "/logs?tab=logs" : `/logs?tab=logs&model=${encodeURIComponent(model)}`;
}
