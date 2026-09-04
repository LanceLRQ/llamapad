/**
 * 档案详情页权重卡的视图偏好（任务 19，用户「增加一个切换视图功能」）——
 * 持久化结构与读写 try/catch 套路照抄 models-sort.ts：SSR 首帧用默认值，
 * localStorage 访问全程可能抛（隐私模式/被禁用/SSR），读写各自兜底，写失败
 * 静默——本次选择只影响当前会话的展示形态，不是需要打断用户的错误。同样
 * 照抄它的模块级 store + useSyncExternalStore：挂载后从 localStorage 切到
 * 用户上次的选择这件事用 useState + useEffect(setState) 写会撞
 * react-hooks/set-state-in-effect，而外部 store 的订阅同步正是该规则要人走的路。
 */

export type RepoWeightsView = "grouped" | "flat";

/** 默认分组：显示仓库目录结构是用户要的改进，平铺是退路不是默认 */
export const DEFAULT_REPO_WEIGHTS_VIEW: RepoWeightsView = "grouped";

export const REPO_WEIGHTS_VIEW_STORAGE_KEY = "llamapad_repo_weights_view";

const VIEWS: readonly RepoWeightsView[] = ["grouped", "flat"];

function isRepoWeightsView(value: string): value is RepoWeightsView {
  return (VIEWS as readonly string[]).includes(value);
}

/** localStorage 里存的字符串 → RepoWeightsView；任何非法值一律回落默认 */
export function parseRepoWeightsView(raw: string | null): RepoWeightsView {
  if (raw === null || !isRepoWeightsView(raw)) return DEFAULT_REPO_WEIGHTS_VIEW;
  return raw;
}

/** 读取本地存储的视图选择；任何异常或脏数据一律回落默认值，绝不抛错 */
export function readRepoWeightsView(): RepoWeightsView {
  try {
    if (typeof window === "undefined") return DEFAULT_REPO_WEIGHTS_VIEW;
    return parseRepoWeightsView(window.localStorage.getItem(REPO_WEIGHTS_VIEW_STORAGE_KEY));
  } catch {
    return DEFAULT_REPO_WEIGHTS_VIEW;
  }
}

/** 写入本地存储；SSR / 隐私模式 / 禁用等异常静默吞掉（不影响内存态选择） */
export function writeRepoWeightsView(view: RepoWeightsView): void {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(REPO_WEIGHTS_VIEW_STORAGE_KEY, view);
  } catch {
    // 静默：写失败不影响本次会话内存态的选择结果
  }
}

type Listener = () => void;

const listeners = new Set<Listener>();
let current: RepoWeightsView = DEFAULT_REPO_WEIGHTS_VIEW;
let hydrated = false;

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * 模块级单例 store（与 models-sort.ts 同款模式），配合 useSyncExternalStore
 * 使用：档案详情页首帧走 getServerSnapshot 恒为默认值，挂载后的 effect 只
 * 调用 hydrate()（不直接 setState），避免触发 react-hooks/set-state-in-effect。
 */
export const repoWeightsViewStore = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  /** useSyncExternalStore 快照，需要引用稳定——未变化时恒返回同一个 current 值 */
  getSnapshot(): RepoWeightsView {
    return current;
  },
  /** SSR / 首次客户端渲染恒为默认值，真实值等 hydrate 在 effect 里读出 */
  getServerSnapshot(): RepoWeightsView {
    return DEFAULT_REPO_WEIGHTS_VIEW;
  },
  /** 客户端挂载后调用一次：从 localStorage 读真实值。幂等 */
  hydrate(): void {
    if (hydrated) return;
    hydrated = true;
    const stored = readRepoWeightsView();
    if (stored !== current) {
      current = stored;
      notify();
    }
  },
  setValue(value: RepoWeightsView): void {
    if (value === current) return;
    current = value;
    writeRepoWeightsView(value);
    notify();
  },
};

/** 测试隔离用：重置内部状态（内存态 / hydrate 标记 / 订阅者全部清空） */
export function resetRepoWeightsViewStoreForTest(): void {
  current = DEFAULT_REPO_WEIGHTS_VIEW;
  hydrated = false;
  listeners.clear();
}
