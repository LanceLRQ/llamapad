/**
 * 监控指标刷新间隔——纯逻辑层（用户反馈"监控指标刷新慢"）：档位定义 +
 * localStorage 读写 + 跨组件同步的模块级 store。vitest 只认 src 目录树下的
 * .test.ts 文件（`src/app` 无测试基础设施，见 run-format.ts 头注释），
 * 这一层是纯函数 + 薄封装，读写 localStorage 这类"可能抛"的浏览器 API
 * 调用集中在这里做单测覆盖，React 侧只留一个瘦身 hook（use-refresh-interval.ts）。
 *
 * 读取要"吃掉一切脏数据"：键不存在、非数字字符串、被手改成不在档位表里
 * 的数字——统统回落默认值，不抛错、不让脏数据打断轮询组件的渲染。
 * localStorage 本身在隐私模式 / 被禁用 / SSR 环境下访问或读写都可能抛，
 * 读写各自 try/catch 兜底；写失败静默（本次选择只影响当前会话的轮询节拍，
 * 不是需要打断用户的错误）。
 */

/** 刷新间隔档位（ms）：最快 1s 与采集侧的秒级节拍对齐（docker stats 流与
 *  nvidia-smi 常驻流均为 1 帧/s），再快没有新数据可读 */
export const REFRESH_INTERVAL_OPTIONS = [1000, 2000, 5000, 10000, 30000] as const;

export type RefreshIntervalMs = (typeof REFRESH_INTERVAL_OPTIONS)[number];

/** 默认档位：5s，与既有轮询间隔的初始体验一致 */
export const DEFAULT_REFRESH_INTERVAL_MS: RefreshIntervalMs = 5000;

export const REFRESH_INTERVAL_STORAGE_KEY = "llamapad_refresh_interval_ms";

function isRefreshIntervalMs(value: number): value is RefreshIntervalMs {
  return (REFRESH_INTERVAL_OPTIONS as readonly number[]).includes(value);
}

/** 读取本地存储的刷新间隔；任何异常或脏数据一律回落默认值，绝不抛错 */
export function readRefreshInterval(): RefreshIntervalMs {
  try {
    if (typeof window === "undefined") return DEFAULT_REFRESH_INTERVAL_MS;
    const raw = window.localStorage.getItem(REFRESH_INTERVAL_STORAGE_KEY);
    if (raw === null) return DEFAULT_REFRESH_INTERVAL_MS;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || !isRefreshIntervalMs(parsed)) {
      return DEFAULT_REFRESH_INTERVAL_MS;
    }
    return parsed;
  } catch {
    return DEFAULT_REFRESH_INTERVAL_MS;
  }
}

/** 写入本地存储；SSR / 隐私模式 / 禁用等异常静默吞掉（不影响内存态选择） */
export function writeRefreshInterval(value: RefreshIntervalMs): void {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(REFRESH_INTERVAL_STORAGE_KEY, String(value));
  } catch {
    // 静默：写失败不影响本次会话内存态的选择结果
  }
}

type Listener = () => void;

const listeners = new Set<Listener>();
let current: RefreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS;
let hydrated = false;

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * 模块级单例 store（与 connection-store.ts / toast-store.ts 同款模式）：
 * 监控页与概览页的选择器各自独立挂载、互不知晓对方存在，靠共享这一份
 * 内存态联动——改一处，另一处的 useSyncExternalStore 订阅自动重渲染。
 */
export const refreshIntervalStore = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  /** useSyncExternalStore 快照（原始值，天然引用稳定） */
  getSnapshot(): RefreshIntervalMs {
    return current;
  },
  /** SSR / 首次客户端渲染恒为默认值——真实值要等 hydrate 在 effect 里读出，
   *  避免服务端无 window 导致的读取分叉造成 hydration mismatch */
  getServerSnapshot(): RefreshIntervalMs {
    return DEFAULT_REFRESH_INTERVAL_MS;
  },
  /** 客户端挂载后调用一次：从 localStorage 读真实值。幂等——多个选择器
   *  组件同时挂载时只有第一次调用真正生效，后续调用直接跳过 */
  hydrate(): void {
    if (hydrated) return;
    hydrated = true;
    const stored = readRefreshInterval();
    if (stored !== current) {
      current = stored;
      notify();
    }
  },
  setValue(value: RefreshIntervalMs): void {
    if (value === current) return;
    current = value;
    writeRefreshInterval(value);
    notify();
  },
};

/** 测试隔离用：重置内部状态（内存态 / hydrate 标记 / 订阅者全部清空） */
export function resetRefreshIntervalStoreForTest(): void {
  current = DEFAULT_REFRESH_INTERVAL_MS;
  hydrated = false;
  listeners.clear();
}
