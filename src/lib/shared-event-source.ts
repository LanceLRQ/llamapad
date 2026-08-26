/**
 * 同端点 SSE 连接共享（UX P0 走查发现的修复）：面板每页现在有多个 SSE 消费者
 * （layout 事件监听 / 顶栏下载徽标 / 页面自身的事件卡、下载视图），各自 new
 * EventSource 会把同端点连接翻倍——HTTP/1.1 同源 6 连接上限下，两个标签页
 * 即可把导航饿死（实测）。本模块按 URL 去重：同端点一页只有一条连接，
 * 订阅计数归零即关闭。
 *
 * 纯逻辑（注册表/计数/扇出）与 DOM 解耦：createStreamRegistry 接受注入的
 * 连接工厂，单测用假 source 覆盖；subscribeStream 是浏览器侧默认单例。
 */

/** 与 EventSource 的最小接口面（测试可注入假实现） */
export interface StreamSourceLike {
  onmessage: ((event: { data: string }) => void) | null;
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  close(): void;
}

export interface StreamSubscription {
  onData: (data: string) => void;
  /** 连接状态迁移通知（true=open，false=error/断开）；注册时即回放当前态 */
  onStateChange?: (connected: boolean) => void;
}

export interface StreamRegistry {
  subscribe(url: string, sub: StreamSubscription): () => void;
  /** 测试观测：当前活跃连接数 */
  activeCount(): number;
}

export function createStreamRegistry(
  openSource: (url: string) => StreamSourceLike,
): StreamRegistry {
  interface Entry {
    source: StreamSourceLike;
    subs: Set<StreamSubscription>;
    connected: boolean;
  }
  const entries = new Map<string, Entry>();

  function emitState(entry: Entry, connected: boolean): void {
    if (entry.connected === connected) return;
    entry.connected = connected;
    for (const sub of entry.subs) sub.onStateChange?.(connected);
  }

  return {
    subscribe(url, sub) {
      let entry = entries.get(url);
      if (entry === undefined) {
        const source = openSource(url);
        const fresh: Entry = { source, subs: new Set(), connected: false };
        source.onmessage = (event) => {
          for (const listener of fresh.subs) listener.onData(event.data);
        };
        source.onopen = () => emitState(fresh, true);
        source.onerror = () => emitState(fresh, false);
        entries.set(url, fresh);
        entry = fresh;
      }
      entry.subs.add(sub);
      // 注册即回放当前连接态（晚加入的订阅者不丢失状态指示）
      sub.onStateChange?.(entry.connected);
      return () => {
        const current = entries.get(url);
        if (current === undefined || !current.subs.delete(sub)) return;
        if (current.subs.size === 0) {
          current.source.close();
          entries.delete(url);
        }
      };
    },
    activeCount() {
      return entries.size;
    },
  };
}

/** 浏览器侧默认单例（client 组件在 effect 中订阅，SSR 不触碰 EventSource） */
export const browserStreamRegistry = createStreamRegistry(
  (url) => new EventSource(url) as unknown as StreamSourceLike,
);

export function subscribeStream(url: string, sub: StreamSubscription): () => void {
  return browserStreamRegistry.subscribe(url, sub);
}
