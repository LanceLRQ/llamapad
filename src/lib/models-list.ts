/**
 * /v1/models 聚合（多模型并行，决策 D7）
 *
 * 单模型时代中转把这个请求转给唯一的 llama-server。多模型下由面板自己组装：
 * 逐个拉各实例的 /v1/models（IO 在 server/modelsListProxy.ts），再在这里合并成
 * OpenAI 标准的 {object:"list", data:[…]}。
 *
 * 上游顶层的 models 数组（llama-server 为兼容 Ollama 附带的）不带出来：
 * 标准格式里没有它，多个实例的 models 合在一起也没有明确含义。
 */

export interface ModelsListEntry {
  /** 面板模型名 */
  model: string;
  /** 上游响应体（已做思考强度声明注入）；拉取失败或未就绪为 null */
  body: string | null;
}

export interface ModelsListBody {
  object: "list";
  data: Record<string, unknown>[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstModelItem(body: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.data)) return null;
  const item = parsed.data.find(isPlainObject);
  return item ?? null;
}

export function mergeModelLists(entries: readonly ModelsListEntry[]): ModelsListBody {
  const data: Record<string, unknown>[] = [];
  for (const entry of entries) {
    if (entry.body === null) continue;
    const item = firstModelItem(entry.body);
    if (item === null) continue;
    // id 强制为面板模型名：路由认的是它（见文件头与 lib/model-route.ts）
    data.push({ ...item, id: entry.model });
  }
  return { object: "list", data };
}

/** 默认模型排第一：不少客户端在用户没选模型时取列表第一项 */
export function orderForModelsList<T extends { model: string }>(models: readonly T[], defaultModel: string | null): T[] {
  const index = models.findIndex((m) => m.model === defaultModel);
  if (index <= 0) return [...models];
  return [models[index], ...models.slice(0, index), ...models.slice(index + 1)];
}
