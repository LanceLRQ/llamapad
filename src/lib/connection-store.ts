/**
 * 全局连接状态存储（UX P0 Task 2/3 / U10）：模块级单例 + useSyncExternalStore
 * 消费（与 theme-toggle 同款模式，无 context）。
 *
 * 判定信号互补：
 * - apiFetch 成败（api.ts 喂入）：面板容器重启 / 反代断开时 fetch 以网络异常
 *   表现，而 navigator.onLine 仍为 true——这是本 store 存在的理由；
 * - 浏览器 online/offline 事件（状态栏 client 内件安装时接线）：整机断网即时判定。
 *
 * 连续失败 ≥ 阈值才判离线（单次抖动不误报）；任一成功即恢复。
 */

export type ConnectionState = "online" | "offline";

/** 连续网络失败判离线的阈值 */
export const CONNECTION_FAILURE_THRESHOLD = 2;

type Listener = () => void;

const listeners = new Set<Listener>();
let state: ConnectionState = "online";
let consecutiveFailures = 0;

function notify(): void {
  for (const listener of listeners) listener();
}

export const connectionStore = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  /** useSyncExternalStore 快照（原始值，天然引用稳定） */
  getSnapshot(): ConnectionState {
    return state;
  },
  /** SSR / 水合首帧恒在线（真断线由客户端 effect 接线后修正） */
  getServerSnapshot(): ConnectionState {
    return "online";
  },
  /** 网络层失败（fetch 抛异常）；累计达阈值才置离线 */
  reportRequestFailure(): void {
    consecutiveFailures += 1;
    if (state === "online" && consecutiveFailures >= CONNECTION_FAILURE_THRESHOLD) {
      state = "offline";
      notify();
    }
  },
  /** 任一次 HTTP 往返成功即恢复在线 */
  reportRequestSuccess(): void {
    consecutiveFailures = 0;
    if (state === "offline") {
      state = "online";
      notify();
    }
  },
  /** 浏览器 offline 事件：即时判离线（不经阈值） */
  reportBrowserOffline(): void {
    consecutiveFailures = CONNECTION_FAILURE_THRESHOLD;
    if (state === "online") {
      state = "offline";
      notify();
    }
  },
};

/** 测试隔离用：重置内部计数与状态 */
export function resetConnectionStoreForTest(): void {
  consecutiveFailures = 0;
  state = "online";
}
