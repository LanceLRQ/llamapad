import { describe, expect, it } from "vitest";
import { createLogBufferStore, startLogsStream, LOG_BUFFER_CAPACITY, type LogBufferStore } from "./logsStream";
import type { SseSession } from "./sse";

/**
 * 日志流核心逻辑测试（M3 Task 1）
 *
 * 全部注入假依赖（fake adapter / fake getRunning / 录制式 session），
 * 不触碰真实 Docker / db；route 只是把这些拼起来的薄壳。
 */

describe("createLogBufferStore：环形缓冲", () => {
  it("append 返回每容器递增的行号（id 从 1 起）", () => {
    const store = createLogBufferStore();
    expect(store.append("c1", "a")).toBe(1);
    expect(store.append("c1", "b")).toBe(2);
    // 计数器 per container：另一容器独立从 1 起
    expect(store.append("c2", "x")).toBe(1);
    expect(store.append("c1", "c")).toBe(3);
  });

  it("容量 500：只保留最近 500 行，被挤出的行不可补发，计数器继续递增", () => {
    const store = createLogBufferStore();
    for (let i = 1; i <= 600; i++) store.append("c1", `line-${i}`);
    const replayed = store.replay("c1", 0);
    expect(replayed).toHaveLength(500);
    expect(replayed[0]).toEqual({ id: 101, line: "line-101" });
    expect(replayed[499]).toEqual({ id: 600, line: "line-600" });
    // 计数器不被环形裁剪重置
    expect(store.append("c1", "line-601")).toBe(601);
  });

  it("replay(container, afterId)：只返回 id 严格大于 afterId 的行；无缓冲的容器返回空", () => {
    const store = createLogBufferStore();
    for (let i = 1; i <= 8; i++) store.append("c1", `line-${i}`);

    const from5 = store.replay("c1", 5);
    expect(from5.map((e) => e.id)).toEqual([6, 7, 8]);
    // afterId 超过已有最大 id：无行可补
    expect(store.replay("c1", 8)).toEqual([]);
    expect(store.replay("c1", 999)).toEqual([]);
    // 从未收过行的容器
    expect(store.replay("unknown", 0)).toEqual([]);
  });
});

// ---------- startLogsStream：注入假依赖的流会话 ----------

/** 录制式 session：按序记下每次 send 的 (event, id) */
function recordingSession() {
  const events: { event: unknown; id?: number | string }[] = [];
  const session: SseSession = {
    send: (event, id) => events.push({ event, id }),
    comment: () => undefined,
  };
  return { session, events };
}

/** 假适配器：注册各容器的 onLine，测试直接 emit 伪造日志行 */
function fakeFollowAdapter() {
  const handles = new Map<string, { onLine: (line: string) => void; stopped: boolean }>();
  return {
    async followLogs(name: string, onLine: (line: string) => void) {
      const handle = { onLine, stopped: false };
      handles.set(name, handle);
      return {
        stop: async () => {
          handle.stopped = true;
        },
      };
    },
    /** 测试驱动：向 name 的活动 follow 推一行 */
    emit(name: string, line: string) {
      const handle = handles.get(name);
      if (handle && !handle.stopped) handle.onLine(line);
    },
    /** name 当前是否在被跟随（句柄存在且未 stop） */
    isFollowed(name: string) {
      const handle = handles.get(name);
      return handle !== undefined && !handle.stopped;
    },
  };
}

/** 等到谓词为真（真实时钟轮询 5ms，最多 timeoutMs） */
async function until(assert: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!assert()) {
    if (Date.now() > deadline) throw new Error("until: 条件超时未满足");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 可变运行状态：getRunning 按测试推进切换返回值 */
function switchableRunning(initial: { container: string; displayName: string } | null) {
  let current = initial;
  return {
    getRunning: () => Promise.resolve(current),
    set(next: { container: string; displayName: string } | null) {
      current = next;
    },
  };
}

describe("startLogsStream：正常行流", () => {
  it("attach 后每行入缓冲并带递增 id 发送；先发 container 元事件", async () => {
    const adapter = fakeFollowAdapter();
    const running = switchableRunning({ container: "llama-c1", displayName: "模型 A" });
    const { session, events } = recordingSession();
    const store = createLogBufferStore();

    const stream = startLogsStream(session, { adapter, getRunning: running.getRunning }, { store, pollMs: 20 });
    try {
      await until(() => adapter.isFollowed("llama-c1"));

      adapter.emit("llama-c1", "line-1");
      adapter.emit("llama-c1", "line-2");
      adapter.emit("llama-c1", "line-3");

      expect(events).toEqual([
        { event: { type: "container", name: "模型 A" }, id: undefined },
        { event: { type: "log", line: "line-1" }, id: 1 },
        { event: { type: "log", line: "line-2" }, id: 2 },
        { event: { type: "log", line: "line-3" }, id: 3 },
      ]);
    } finally {
      await stream.stop();
    }
  });
});

describe("startLogsStream：Last-Event-ID 断线补发", () => {
  it("lastEventId=5：初始 attach 先补发 id 6+ 的存量行（带 id 帧），再接实时（id 续上）", async () => {
    const adapter = fakeFollowAdapter();
    const running = switchableRunning({ container: "llama-c1", displayName: "模型 A" });
    const { session, events } = recordingSession();
    const store: LogBufferStore = createLogBufferStore();
    // 模拟上一条连接已收 8 行（id 1..8 存在共享缓冲里）
    for (let i = 1; i <= 8; i++) store.append("llama-c1", `old-${i}`);

    const stream = startLogsStream(
      session,
      { adapter, getRunning: running.getRunning },
      { store, pollMs: 20, lastEventId: 5 },
    );
    try {
      await until(() => adapter.isFollowed("llama-c1"));
      expect(events).toEqual([
        { event: { type: "container", name: "模型 A" }, id: undefined },
        { event: { type: "log", line: "old-6" }, id: 6 },
        { event: { type: "log", line: "old-7" }, id: 7 },
        { event: { type: "log", line: "old-8" }, id: 8 },
      ]);

      // 补发完成后接实时：新行 id 在存量计数器上继续递增
      adapter.emit("llama-c1", "new-1");
      expect(events[4]).toEqual({ event: { type: "log", line: "new-1" }, id: 9 });
    } finally {
      await stream.stop();
    }
  });

  it("缓冲已没有该 id 之后的行（客户端落后太多 / 缓冲被环形裁剪）：无补发、直接实时", async () => {
    const adapter = fakeFollowAdapter();
    const running = switchableRunning({ container: "llama-c1", displayName: "模型 A" });
    const { session, events } = recordingSession();
    const store = createLogBufferStore(3);
    for (let i = 1; i <= 5; i++) store.append("llama-c1", `old-${i}`); // 只剩 id 3..5

    const stream = startLogsStream(
      session,
      { adapter, getRunning: running.getRunning },
      { store, pollMs: 20, lastEventId: 9 },
    );
    try {
      await until(() => adapter.isFollowed("llama-c1"));
      expect(events).toEqual([{ event: { type: "container", name: "模型 A" }, id: undefined }]);
      adapter.emit("llama-c1", "live");
      expect(events[1]).toEqual({ event: { type: "log", line: "live" }, id: 6 });
    } finally {
      await stream.stop();
    }
  });
});

describe("startLogsStream：容器切换", () => {
  it("运行容器名变化 → stop 旧句柄、follow 新容器、发新 container 元事件；行来自新容器", async () => {
    const adapter = fakeFollowAdapter();
    const running = switchableRunning({ container: "llama-c1", displayName: "模型 A" });
    const { session, events } = recordingSession();

    const stream = startLogsStream(
      session,
      { adapter, getRunning: running.getRunning },
      { pollMs: 20, store: createLogBufferStore() },
    );
    try {
      await until(() => adapter.isFollowed("llama-c1"));
      adapter.emit("llama-c1", "from-c1");

      running.set({ container: "llama-c2", displayName: "模型 B" });
      await until(() => adapter.isFollowed("llama-c2"));

      expect(adapter.isFollowed("llama-c1")).toBe(false); // 旧句柄已停
      adapter.emit("llama-c1", "stale"); // 旧容器再出声也不转发
      adapter.emit("llama-c2", "from-c2"); // 新容器行 id 从 1 重新起算（per-container 计数器）

      expect(events).toEqual([
        { event: { type: "container", name: "模型 A" }, id: undefined },
        { event: { type: "log", line: "from-c1" }, id: 1 },
        { event: { type: "container", name: "模型 B" }, id: undefined },
        { event: { type: "log", line: "from-c2" }, id: 1 },
      ]);
    } finally {
      await stream.stop();
    }
  });
});

describe("startLogsStream：waiting", () => {
  it("无运行容器 → 发一次 waiting 元事件，后续 poll 不重复；容器出现后接入", async () => {
    const adapter = fakeFollowAdapter();
    const running = switchableRunning(null);
    const { session, events } = recordingSession();

    const stream = startLogsStream(
      session,
      { adapter, getRunning: running.getRunning },
      { pollMs: 20, store: createLogBufferStore() },
    );
    try {
      await until(() => events.some((e) => (e.event as { type?: string }).type === "waiting"));
      // 跨过多个 poll 周期仍只有一条 waiting
      await new Promise((resolve) => setTimeout(resolve, 80));
      const waitingCount = events.filter((e) => (e.event as { type?: string }).type === "waiting").length;
      expect(waitingCount).toBe(1);

      // 容器出现：接入并发 container 元事件
      running.set({ container: "llama-c1", displayName: "模型 A" });
      await until(() => adapter.isFollowed("llama-c1"));
      adapter.emit("llama-c1", "hello");
      expect(events[events.length - 2]).toEqual({ event: { type: "container", name: "模型 A" }, id: undefined });
      expect(events[events.length - 1]).toEqual({ event: { type: "log", line: "hello" }, id: 1 });
    } finally {
      await stream.stop();
    }
  });

  it("容器消失（停止运行）→ 摘掉句柄并再发一次 waiting（新一轮空窗）", async () => {
    const adapter = fakeFollowAdapter();
    const running = switchableRunning({ container: "llama-c1", displayName: "模型 A" });
    const { session, events } = recordingSession();

    const stream = startLogsStream(
      session,
      { adapter, getRunning: running.getRunning },
      { pollMs: 20, store: createLogBufferStore() },
    );
    try {
      await until(() => adapter.isFollowed("llama-c1"));
      running.set(null);
      await until(() => events.some((e) => (e.event as { type?: string }).type === "waiting"));
      expect(adapter.isFollowed("llama-c1")).toBe(false);
    } finally {
      await stream.stop();
    }
  });
});

describe("createLogBufferStore：磁盘落盘旁路", () => {
  it("append 时旁路调用注入的 diskStore.append，且不等待其 resolve（fire-and-forget）", () => {
    const calls: { container: string; lines: string[] }[] = [];
    const diskStore = {
      append: (container: string, lines: string[]) => {
        calls.push({ container, lines });
        return new Promise<void>(() => {}); // 故意永不 resolve，验证 append 不会等它
      },
    };
    const store = createLogBufferStore(LOG_BUFFER_CAPACITY, { diskStore });
    const id = store.append("c1", "hello");
    expect(id).toBe(1); // 同步返回，未被 diskStore.append 悬而不决的 promise 卡住
    expect(calls).toEqual([{ container: "c1", lines: ["hello"] }]);
  });

  it("未注入 diskStore 时行为与之前完全一致", () => {
    const store = createLogBufferStore();
    expect(store.append("c1", "x")).toBe(1);
  });
});

describe("startLogsStream：磁盘历史回灌", () => {
  function fakeDiskStore(initial: Record<string, string[]> = {}) {
    return {
      tail: async (container: string, n: number) => (initial[container] ?? []).slice(-n),
    };
  }

  it("内存缓冲为空且无 Last-Event-ID：attach 先发一帧磁盘历史，再接实时（id 从 1 起，不受历史影响）", async () => {
    const adapter = fakeFollowAdapter();
    const running = switchableRunning({ container: "llama-c1", displayName: "模型 A" });
    const { session, events } = recordingSession();
    const store = createLogBufferStore();
    const diskStore = fakeDiskStore({ "llama-c1": ["old-a", "old-b"] });

    const stream = startLogsStream(
      session,
      { adapter, getRunning: running.getRunning },
      { store, pollMs: 20, diskStore },
    );
    try {
      await until(() => adapter.isFollowed("llama-c1"));
      expect(events).toEqual([
        { event: { type: "container", name: "模型 A" }, id: undefined },
        { event: { type: "history", lines: ["old-a", "old-b"] }, id: undefined },
      ]);
      adapter.emit("llama-c1", "live-1");
      expect(events[2]).toEqual({ event: { type: "log", line: "live-1" }, id: 1 });
    } finally {
      await stream.stop();
    }
  });

  it("内存缓冲非空时不回灌磁盘历史", async () => {
    const adapter = fakeFollowAdapter();
    const running = switchableRunning({ container: "llama-c1", displayName: "模型 A" });
    const { session, events } = recordingSession();
    const store = createLogBufferStore();
    store.append("llama-c1", "already-buffered");
    const diskStore = fakeDiskStore({ "llama-c1": ["old-a"] });

    const stream = startLogsStream(
      session,
      { adapter, getRunning: running.getRunning },
      { store, pollMs: 20, diskStore },
    );
    try {
      await until(() => adapter.isFollowed("llama-c1"));
      expect(events.some((e) => (e.event as { type?: string }).type === "history")).toBe(false);
    } finally {
      await stream.stop();
    }
  });

  it("带 Last-Event-ID 时即使内存缓冲为空也不触发磁盘回灌，维持既有补发语义", async () => {
    const adapter = fakeFollowAdapter();
    const running = switchableRunning({ container: "llama-c1", displayName: "模型 A" });
    const { session, events } = recordingSession();
    const store = createLogBufferStore(); // 空缓冲：模拟面板刚重启
    const diskStore = fakeDiskStore({ "llama-c1": ["disk-history"] });

    const stream = startLogsStream(
      session,
      { adapter, getRunning: running.getRunning },
      { store, pollMs: 20, lastEventId: 5, diskStore },
    );
    try {
      await until(() => adapter.isFollowed("llama-c1"));
      // 既有语义：空缓冲下 Last-Event-ID 补发不到任何行，且不会转去磁盘回灌
      expect(events).toEqual([{ event: { type: "container", name: "模型 A" }, id: undefined }]);
      adapter.emit("llama-c1", "live-1");
      expect(events[1]).toEqual({ event: { type: "log", line: "live-1" }, id: 1 });
    } finally {
      await stream.stop();
    }
  });
});

describe("startLogsStream：stop", () => {
  it("stop 幂等：停 follow 句柄、轮询循环退出（后续容器变化不再接入）", async () => {
    const adapter = fakeFollowAdapter();
    const running = switchableRunning({ container: "llama-c1", displayName: "模型 A" });
    const { session } = recordingSession();

    const stream = startLogsStream(
      session,
      { adapter, getRunning: running.getRunning },
      { pollMs: 20, store: createLogBufferStore() },
    );
    await until(() => adapter.isFollowed("llama-c1"));

    await stream.stop();
    await stream.stop(); // 幂等
    expect(adapter.isFollowed("llama-c1")).toBe(false);

    running.set({ container: "llama-c2", displayName: "模型 B" });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(adapter.isFollowed("llama-c2")).toBe(false); // 循环已退出
  });
});
