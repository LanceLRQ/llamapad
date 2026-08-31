/**
 * 模型配置列表排序——纯逻辑层（用户原话「模型配置列表里边项目可以按名称和
 * 时间进行排序吗，本地浏览器记忆，默认按照名称正序排序」）。
 *
 * 排序键固定两个：name（名称）与 created（创建时间，取 created_at 而非
 * updated_at——改一次参数就把模型顶到列表最前，作为排序键太跳）。
 * 持久化结构与读写 try/catch 套路照抄 refresh-interval.ts：SSR 首帧用
 * 默认值、localStorage 访问全程可能抛（隐私模式/被禁用/SSR），读写各自
 * 兜底，写失败静默——本次选择只影响当前会话的排序观感，不是需要打断用户
 * 的错误。同样照抄它的模块级 store + useSyncExternalStore：不是为了跨组件
 * 同步（目前只有 models-table.tsx 一处消费），而是因为「挂载后从 localStorage
 * 切到用户上次的选择」这件事用 useState + useEffect(setState) 写会撞
 * react-hooks/set-state-in-effect，而外部 store 的订阅同步正是该规则要人走的路。
 */

export type ModelSortKey = "name" | "created";
export type ModelSortDir = "asc" | "desc";

export interface ModelSort {
  key: ModelSortKey;
  dir: ModelSortDir;
}

/** 默认排序：名称正序（用户明确要求的默认值） */
export const DEFAULT_MODEL_SORT: ModelSort = { key: "name", dir: "asc" };

export const MODEL_SORT_STORAGE_KEY = "llamapad_models_sort";

const SORT_KEYS: readonly ModelSortKey[] = ["name", "created"];
const SORT_DIRS: readonly ModelSortDir[] = ["asc", "desc"];

function isSortKey(value: string): value is ModelSortKey {
  return (SORT_KEYS as readonly string[]).includes(value);
}

function isSortDir(value: string): value is ModelSortDir {
  return (SORT_DIRS as readonly string[]).includes(value);
}

/** 比较器收的最小结构性类型——lib 不依赖 server 的 ModelView，调用方按需裁剪字段传入 */
export interface SortableModel {
  name: string;
  createdAt: string;
}

/**
 * 按 key/dir 比较两个模型。name 用 localeCompare 的稳定口径；created 比
 * 时间戳，时间戳相同（同一批建的模型很常见）时退回名称升序兜底——且这个
 * 兜底恒为升序、不受 dir 影响，否则同一批模型在 desc 下的相对顺序会因为
 * 遍历实现细节而在两次渲染间抖动。
 */
export function compareModels(a: SortableModel, b: SortableModel, sort: ModelSort): number {
  if (sort.key === "created") {
    const diff = Date.parse(a.createdAt) - Date.parse(b.createdAt);
    if (diff !== 0) return sort.dir === "asc" ? diff : -diff;
    return a.name.localeCompare(b.name);
  }
  const cmp = a.name.localeCompare(b.name);
  return sort.dir === "asc" ? cmp : -cmp;
}

/** localStorage 里存的字符串（"key:dir"）→ ModelSort；任何非法值一律回落默认 */
export function parseModelSort(raw: string | null): ModelSort {
  if (!raw) return DEFAULT_MODEL_SORT;
  const [key, dir] = raw.split(":");
  if (key === undefined || dir === undefined || !isSortKey(key) || !isSortDir(dir)) {
    return DEFAULT_MODEL_SORT;
  }
  return { key, dir };
}

/** ModelSort → 存进 localStorage 的字符串 */
export function serializeModelSort(sort: ModelSort): string {
  return `${sort.key}:${sort.dir}`;
}

/** ModelSort → i18n 文案 key，触发器（受控 Select 的 SelectValue）与四个
 *  SelectItem 的文案共用这一份映射，避免同一组文案在 JSX 里各写一遍——
 *  新增一种排序时只需要改这里 */
export type ModelSortLabelKey =
  | "sortNameAsc"
  | "sortNameDesc"
  | "sortCreatedAsc"
  | "sortCreatedDesc";

export function modelSortLabelKey(sort: ModelSort): ModelSortLabelKey {
  if (sort.key === "created") {
    return sort.dir === "asc" ? "sortCreatedAsc" : "sortCreatedDesc";
  }
  return sort.dir === "asc" ? "sortNameAsc" : "sortNameDesc";
}

/**
 * 表头点击排序的下一状态判定（批 F，「模型」表头可点）：与下拉共用
 * modelSortStore，但表头只管名称这一维——时间排序维持只能从下拉选的现状。
 * 因此不是按名称排序时点一下一律先落到名称升序（不会把用户已选的创建时间
 * 排序直接换方向，那样等于表头替用户做了个跟点击意图无关的决定）；已经
 * 按名称排序时才在升/降之间来回切换。
 */
export function nextNameSort(current: ModelSort): ModelSort {
  if (current.key !== "name") return { key: "name", dir: "asc" };
  return { key: "name", dir: current.dir === "asc" ? "desc" : "asc" };
}

/** 读取本地存储的排序选择；任何异常或脏数据一律回落默认值，绝不抛错 */
export function readModelSort(): ModelSort {
  try {
    if (typeof window === "undefined") return DEFAULT_MODEL_SORT;
    return parseModelSort(window.localStorage.getItem(MODEL_SORT_STORAGE_KEY));
  } catch {
    return DEFAULT_MODEL_SORT;
  }
}

/** 写入本地存储；SSR / 隐私模式 / 禁用等异常静默吞掉（不影响内存态选择） */
export function writeModelSort(sort: ModelSort): void {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(MODEL_SORT_STORAGE_KEY, serializeModelSort(sort));
  } catch {
    // 静默：写失败不影响本次会话内存态的选择结果
  }
}

type Listener = () => void;

const listeners = new Set<Listener>();
let current: ModelSort = DEFAULT_MODEL_SORT;
let hydrated = false;

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * 模块级单例 store（与 refresh-interval.ts 同款模式），配合 useSyncExternalStore
 * 使用：models-table.tsx 首帧走 getServerSnapshot 恒为默认值，挂载后的 effect
 * 只调用 hydrate()（不直接 setState），避免触发 react-hooks/set-state-in-effect——
 * hydrate 内部改的是模块级变量并自行通知订阅者，是 React 官方认可的外部
 * 状态同步写法，不是"在 effect 里 setState"。
 */
export const modelSortStore = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  /** useSyncExternalStore 快照，需要引用稳定——未变化时恒返回同一个 current 对象 */
  getSnapshot(): ModelSort {
    return current;
  },
  /** SSR / 首次客户端渲染恒为默认值，真实值等 hydrate 在 effect 里读出 */
  getServerSnapshot(): ModelSort {
    return DEFAULT_MODEL_SORT;
  },
  /** 客户端挂载后调用一次：从 localStorage 读真实值。幂等 */
  hydrate(): void {
    if (hydrated) return;
    hydrated = true;
    const stored = readModelSort();
    if (stored.key !== current.key || stored.dir !== current.dir) {
      current = stored;
      notify();
    }
  },
  setValue(value: ModelSort): void {
    if (value.key === current.key && value.dir === current.dir) return;
    current = value;
    writeModelSort(value);
    notify();
  },
};

/** 测试隔离用：重置内部状态（内存态 / hydrate 标记 / 订阅者全部清空） */
export function resetModelSortStoreForTest(): void {
  current = DEFAULT_MODEL_SORT;
  hydrated = false;
  listeners.clear();
}
