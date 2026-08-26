/**
 * 容器日志流核心逻辑（M3 Task 1）
 *
 * GET /api/v1/logs/stream 的全部可单测行为收敛在此，route 只是薄壳：
 * - 环形缓冲（每容器最近 500 行 + per-container 全局递增行号）
 * - Last-Event-ID 断线重连：补发缓冲中 id 之后的行（带 id 帧）再接实时
 * - 容器切换：轮询运行状态，容器名变化 → 换 follow 句柄 + 发 container 元事件
 * - 无运行容器：发一次 waiting 元事件，只留 SSE 心跳，poll 到有容器再接入
 */
import path from "node:path";
import type { DockerAdapter } from "./adapters/types";
import { createLogStore, type LogStore } from "./logStore";
import { getConfigPath } from "./panelConfig";
import type { SseSession } from "./sse";

/** 缓冲条目：行号（即 SSE id）+ 行文本 */
interface BufferedLine {
  id: number;
  line: string;
}

/** 每容器的环形缓冲与行号计数器 */
interface ContainerBuffer {
  lines: BufferedLine[];
  counter: number;
}

/** 日志环形缓冲：append 入缓冲并返回新行号；replay 取 afterId 之后的存量行 */
export interface LogBufferStore {
  append(container: string, line: string): number;
  replay(container: string, afterId: number): BufferedLine[];
}

/** 默认保留行数（≈ docker logs --tail 的常用量级，防内存无界增长） */
export const LOG_BUFFER_CAPACITY = 500;

export interface LogBufferStoreOptions {
  /**
   * 磁盘落盘旁路（U19）：append 时把行转交它写盘，用于面板重启后的历史回灌。
   * 必须 fire-and-forget——append 是同步返回 id 的接口，不能因落盘变慢而拖慢 SSE 转发。
   * 测试可不传（不落盘，行为与之前完全一致）。
   */
  diskStore?: Pick<LogStore, "append">;
}

export function createLogBufferStore(
  capacity: number = LOG_BUFFER_CAPACITY,
  options: LogBufferStoreOptions = {},
): LogBufferStore {
  const buffers = new Map<string, ContainerBuffer>();
  const { diskStore } = options;

  return {
    append(container, line) {
      let buffer = buffers.get(container);
      if (!buffer) {
        buffer = { lines: [], counter: 0 };
        buffers.set(container, buffer);
      }
      const id = ++buffer.counter;
      buffer.lines.push({ id, line });
      // 环形裁剪：只留最近 capacity 行（计数器不重置，id 单调递增）
      if (buffer.lines.length > capacity) {
        buffer.lines.splice(0, buffer.lines.length - capacity);
      }
      // 落盘旁路：不 await，失败与延迟都不能影响本次 append 的返回时序
      if (diskStore) {
        void diskStore.append(container, [line]);
      }
      return id;
    },

    replay(container, afterId) {
      const buffer = buffers.get(container);
      if (!buffer) return [];
      return buffer.lines.filter((entry) => entry.id > afterId);
    },
  };
}

/** 日志落盘目录：与 export/ 目录同级取法，对齐 snapshot.ts 的 getExportDir */
function getLogsDir(): string {
  return path.join(path.dirname(getConfigPath()), "logs");
}

/** 每次 attach 空缓冲回灌的历史行数上限 */
const HISTORY_TAIL_LINES = 200;

/** 磁盘旁路存储单例：写失败静默降级——落盘是锦上添花，不能拖垮日志流主路径 */
const sharedDiskLogStore: LogStore = createLogStore(getLogsDir(), { failSilently: true });

/** 模块级共享缓冲（route 默认使用，跨连接存活——Last-Event-ID 补发的数据源） */
export const sharedLogBufferStore: LogBufferStore = createLogBufferStore(LOG_BUFFER_CAPACITY, {
  diskStore: sharedDiskLogStore,
});

/** 运行中容器的最小快照（displayName 供 container 元事件展示） */
export interface RunningContainerInfo {
  container: string;
  displayName: string;
}

/** startLogsStream 的依赖注入点：适配器只需 followLogs，运行状态只需一个查询函数 */
export interface LogsStreamDeps {
  adapter: Pick<DockerAdapter, "followLogs">;
  getRunning: () => Promise<RunningContainerInfo | null>;
}

export interface LogsStreamOptions {
  /** 客户端 Last-Event-ID 请求头的值；给定时初始 attach 先补发缓冲存量 */
  lastEventId?: number | string | null;
  /** 运行状态轮询间隔（毫秒）；route 用默认 2s，测试注入小值 */
  pollMs?: number;
  /** 缓冲存储；缺省用模块级共享实例，测试注入独立实例避免串扰 */
  store?: LogBufferStore;
  /** 磁盘历史读取；缺省用模块级共享实例，测试注入假实现避免真实 IO */
  diskStore?: Pick<LogStore, "tail">;
}

/** 日志流句柄：stop 幂等（停止轮询 + 停 follow 句柄） */
export interface LogsStreamHandle {
  stop(): Promise<void>;
}

/** 轮询间隔默认值：容器切换 / 停止的感知延迟上限 */
export const LOGS_POLL_MS = 2_000;

export function startLogsStream(
  session: SseSession,
  deps: LogsStreamDeps,
  options: LogsStreamOptions = {},
): LogsStreamHandle {
  const { pollMs = LOGS_POLL_MS, store = sharedLogBufferStore, diskStore = sharedDiskLogStore } = options;
  /** let 而非常量：补发只在初始 attach 时消费一次，容器切换不重复补 */
  let lastEventId = options.lastEventId ?? null;

  let currentContainer: string | null = null;
  let currentHandle: { stop(): Promise<void> } | null = null;
  /** waiting 元事件每"轮空窗"只发一次，重新接入容器后复位 */
  let waitingSent = false;
  let stopped = false;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      wake = resolve;
      pollTimer = setTimeout(resolve, ms);
    });

  /**
   * 接入容器：元事件 → Last-Event-ID 存量补发（既有语义不变）→
   * 无 Last-Event-ID 且内存缓冲为空时磁盘历史一次性回灌 → follow 实时行入缓冲转发。
   */
  async function attach(container: string, displayName: string): Promise<void> {
    session.send({ type: "container", name: displayName });
    if (lastEventId !== null) {
      const afterId = typeof lastEventId === "number" ? lastEventId : Number(lastEventId);
      if (Number.isFinite(afterId)) {
        for (const { id, line } of store.replay(container, afterId)) {
          session.send({ type: "log", line }, id);
        }
      }
      lastEventId = null;
    } else if (store.replay(container, 0).length === 0) {
      // 面板刚重启：内存环形缓冲从零开始，且客户端未带 Last-Event-ID（不是断线重连）。
      // 从磁盘回灌历史行作为一次性展示，不带 id，不参与 Last-Event-ID 补发语义。
      const history = await diskStore.tail(container, HISTORY_TAIL_LINES);
      if (history.length > 0) {
        session.send({ type: "history", lines: history });
      }
    }
    currentHandle = await deps.adapter.followLogs(container, (line) => {
      const id = store.append(container, line);
      session.send({ type: "log", line }, id);
    });
    waitingSent = false;
  }

  async function pollLoop(): Promise<void> {
    while (!stopped) {
      try {
        const running = await deps.getRunning();
        if (running === null) {
          // 无运行容器：摘掉旧句柄，发一次 waiting，之后只剩 SSE 心跳
          if (currentHandle) {
            await currentHandle.stop();
            currentHandle = null;
            currentContainer = null;
          }
          if (!waitingSent) {
            session.send({ type: "waiting" });
            waitingSent = true;
          }
        } else if (running.container !== currentContainer) {
          if (currentHandle) {
            await currentHandle.stop();
            currentHandle = null;
          }
          await attach(running.container, running.displayName);
          currentContainer = running.container;
        }
      } catch {
        // 单轮失败（docker 抖动等）不终止会话；attach 失败时下轮重试整个接入
        currentContainer = null;
      }
      if (stopped) break;
      await sleep(pollMs);
    }
  }

  void pollLoop();

  return {
    stop: async () => {
      if (stopped) return; // 幂等
      stopped = true;
      clearTimeout(pollTimer);
      wake?.(); // 唤醒睡在 poll 间隔上的循环，让它看到 stopped 退出
      const handle = currentHandle;
      currentHandle = null;
      await handle?.stop();
    },
  };
}
