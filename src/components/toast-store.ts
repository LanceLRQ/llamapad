/**
 * 全局 toast 状态存储（UX P0 Task 1 / U1）：模块级单例 + useSyncExternalStore
 * 消费，命令式 `toast.success/error/info` 供任意 client 组件调用（无 context
 * 传递、无 Provider 嵌套）。组件层只负责渲染（见 toast.tsx 的 <Toaster/>）。
 *
 * 纯逻辑与 React/DOM 解耦：过期定时器挂在 store 内，vitest 假时钟可完整
 * 覆盖入栈 / 过期 / 上限裁剪 / 手动关闭；工厂函数 createToastStore 供测试
 * 隔离实例，默认单例 toastStore 供应用使用。
 */

/** 变体语义：success 成功反馈 / error 失败（含建议，停留更久）/ info 进行中说明 */
export type ToastVariant = "success" | "error" | "info";

export interface ToastItem {
  id: number;
  variant: ToastVariant;
  message: string;
  /** 展示时长 ms；到点自动出栈 */
  duration: number;
}

/** 各变体默认停留时长：错误需要用户读完并可能照做，停留最久 */
export const TOAST_DURATION_MS: Record<ToastVariant, number> = {
  success: 4000,
  info: 5000,
  error: 8000,
};

/** 同屏上限：超出裁最旧（保留最新反馈，避免长任务刷屏堆积） */
export const MAX_TOASTS = 4;

type Listener = () => void;

const EMPTY: ToastItem[] = [];

export interface ToastStore {
  subscribe: (listener: Listener) => () => void;
  /** useSyncExternalStore 快照：引用稳定（变更才换新数组） */
  getSnapshot: () => ToastItem[];
  /** SSR / 水合首帧恒空 */
  getServerSnapshot: () => ToastItem[];
  push: (variant: ToastVariant, message: string, duration?: number) => number;
  dismiss: (id: number) => void;
}

export function createToastStore(): ToastStore {
  let items: ToastItem[] = EMPTY;
  const listeners = new Set<Listener>();
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  let seq = 0;

  function notify(): void {
    for (const listener of listeners) listener();
  }

  function clearTimer(id: number): void {
    const timer = timers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.delete(id);
    }
  }

  function dismiss(id: number): void {
    if (!items.some((item) => item.id === id)) return;
    clearTimer(id);
    items = items.filter((item) => item.id !== id);
    notify();
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => items,
    getServerSnapshot: () => EMPTY,
    push(variant, message, duration = TOAST_DURATION_MS[variant]) {
      const id = ++seq;
      const appended = [...items, { id, variant, message, duration }];
      const overflow = Math.max(0, appended.length - MAX_TOASTS);
      if (overflow > 0) {
        // 裁掉的旧项定时器一并清理，避免过期回调空转
        for (const dropped of appended.slice(0, overflow)) clearTimer(dropped.id);
      }
      items = appended.slice(overflow);
      const timer = setTimeout(() => dismiss(id), duration);
      timers.set(id, timer);
      notify();
      return id;
    },
    dismiss,
  };
}

/** 应用级单例（client 侧命令式 API 的目标实例） */
export const toastStore = createToastStore();

/** 命令式入口：调用方传已翻译文案（store 层不做 i18n） */
export const toast = {
  success: (message: string): number => toastStore.push("success", message),
  error: (message: string): number => toastStore.push("error", message),
  info: (message: string): number => toastStore.push("info", message),
  dismiss: (id: number): void => toastStore.dismiss(id),
};
