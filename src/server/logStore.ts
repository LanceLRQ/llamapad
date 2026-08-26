import fs from "node:fs";
import path from "node:path";

/**
 * 容器日志落盘存储（UX P1 U19）
 *
 * 设计要点：
 * - append 只做内存缓冲，真正写盘统一走 flush（手动调用或 1s 定时器），
 *   避免 llama.cpp 启动时的日志洪流逐行 write 打爆 IO（M4 压测教训）。
 * - 容器名直接决定文件名（<container>.log），必须做白名单校验防目录穿越——
 *   容器名理论上可由配置注入（风险簿 §5）。
 * - 单文件超过 maxBytes 时做二段式裁剪：保留后半段重写，不做多文件轮转，
 *   因为面板日志是排障用途不是审计用途。
 * - failSilently 时写失败只 console.warn 不抛，对齐 snapshot.ts 的
 *   「备份/落盘不能阻塞主流程」惯例。
 */

/** 容器名白名单：仅字母数字下划线点划线，拒绝路径分隔符与相对路径片段 */
const CONTAINER_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

/** 默认单文件上限：8MB（面板日志排障用，不需要更大） */
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/** 默认定时落盘间隔：1s（缓冲期内的同容器多行合并为一次 write） */
const DEFAULT_FLUSH_INTERVAL_MS = 1_000;

export interface LogStoreOptions {
  /** 单文件字节上限，超出触发二段式裁剪（默认 8MB） */
  maxBytes?: number;
  /** 定时落盘间隔毫秒（默认 1000） */
  flushIntervalMs?: number;
  /** 写失败时是否只 console.warn 而不向调用方抛错（默认 false） */
  failSilently?: boolean;
}

export interface LogStore {
  /** 追加若干行到 container 的待落盘缓冲；仅做校验 + 入缓冲，不直接写盘 */
  append(container: string, lines: string[]): Promise<void>;
  /** 立即把所有待落盘缓冲写盘（取消已排的定时器，供测试与进程退出前调用） */
  flush(): Promise<void>;
  /** 读取 container 落盘文件的最后 n 行；文件不存在或容器名不合规返回空数组 */
  tail(container: string, n: number): Promise<string[]>;
}

/** 校验容器名并返回其落盘文件路径；不合规时抛错（含「容器名」关键字供测试断言） */
function resolveLogFile(dir: string, container: string): string {
  if (!CONTAINER_NAME_PATTERN.test(container)) {
    throw new Error(`容器名不合法，拒绝落盘（防目录穿越）: ${container}`);
  }
  return path.join(dir, `${container}.log`);
}

/** 超过 maxBytes 时保留后半段重写：从中点起找最近的换行边界，避免截断半行 */
async function trimIfOversized(file: string, maxBytes: number): Promise<void> {
  const stat = await fs.promises.stat(file);
  if (stat.size <= maxBytes) return;
  const buf = await fs.promises.readFile(file);
  const keepFrom = Math.floor(buf.length / 2);
  const newline = buf.indexOf(0x0a, keepFrom);
  const cut = newline === -1 ? keepFrom : newline + 1;
  await fs.promises.writeFile(file, buf.subarray(cut));
}

export function createLogStore(dir: string, opts: LogStoreOptions = {}): LogStore {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const failSilently = opts.failSilently ?? false;

  /** 待落盘缓冲：容器名 -> 尚未写盘的行，flush 时整体清空 */
  const pending = new Map<string, string[]>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  function scheduleFlush(): void {
    if (timer) return; // 已有定时器在排队，同一批次的多次 append 合并等它触发
    timer = setTimeout(() => {
      timer = undefined;
      // 定时触发的后台落盘无人 await：兜底 catch，避免未处理 rejection 拖垮进程；
      // 用户显式调用 flush() 时仍按 failSilently 决定是否往外抛错
      flushInternal().catch((error) => {
        console.warn("日志定时落盘失败:", error instanceof Error ? error.message : error);
      });
    }, flushIntervalMs);
    timer.unref?.();
  }

  async function writeContainer(container: string, lines: string[]): Promise<void> {
    const file = resolveLogFile(dir, container);
    await fs.promises.mkdir(dir, { recursive: true });
    const text = lines.map((line) => line + "\n").join("");
    await fs.promises.appendFile(file, text, "utf8");
    await trimIfOversized(file, maxBytes);
  }

  async function flushInternal(): Promise<void> {
    const batches = Array.from(pending.entries());
    pending.clear();
    for (const [container, lines] of batches) {
      if (lines.length === 0) continue;
      try {
        await writeContainer(container, lines);
      } catch (error) {
        if (!failSilently) throw error;
        console.warn(`日志落盘失败（不影响日志流）: ${container}`, error instanceof Error ? error.message : error);
      }
    }
  }

  return {
    async append(container, lines) {
      resolveLogFile(dir, container); // 仅校验容器名，不合规立即抛错（不进入缓冲）
      if (lines.length === 0) return;
      const buffered = pending.get(container);
      if (buffered) buffered.push(...lines);
      else pending.set(container, [...lines]);
      scheduleFlush();
    },

    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      await flushInternal();
    },

    async tail(container, n) {
      if (!CONTAINER_NAME_PATTERN.test(container)) return [];
      const file = path.join(dir, `${container}.log`);
      let text: string;
      try {
        text = await fs.promises.readFile(file, "utf8");
      } catch {
        return [];
      }
      const lines = text.split("\n").filter((line) => line.length > 0);
      return lines.slice(-n);
    },
  };
}
