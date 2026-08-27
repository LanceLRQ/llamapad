/**
 * 关机兜底（真机实测，2026-08-27）
 *
 * 现象：浏览器开着面板时 `docker stop` 必然撑满 10 秒宽限期后被 SIGKILL
 * （实测 10178ms / exit 137；无长连接时 182ms / exit 143）。
 *
 * 成因在 Next 自身：它的 SIGTERM 处理第一步是 `await server.close()`，而
 * `server.closeAllConnections()` 只在 dev 模式下调用（见
 * next/dist/server/lib/start-server.js）。生产模式下 `server.close()` 的语义是
 * "等所有现存连接自然结束"，而面板有三条永不结束的 SSE 流（logs / events /
 * downloads），浏览器挂着一条就永远等不到回调。
 *
 * 处置：给关机加**上限**而不是绕过 Next 的收尾。Node 会把同一信号的所有监听器
 * 都跑一遍，Next 那套优雅收尾照常先跑，卡住了才由这里的定时器兜底强制退出。
 *
 * 代价：真有在途长请求会在宽限期后被切断。面板的长连接只有 SSE，本就设计成
 * 可随时重连，没有需要保护的事务；SQLite 走 WAL + 同步写，强制退出不损坏数据。
 * 实际损失是内存里尚未 flush 的分钟累加器（最多约一分钟的指标桶）。
 */

/** 留给 Next 优雅收尾的上限；到点仍未退出即强制退出 */
export const SHUTDOWN_GRACE_MS = 2_000;

/** 退出码与 Next 自身 cleanup 保持一致（128 + 信号号），便于外部按码判断死因 */
const EXIT_CODES = { SIGTERM: 143, SIGINT: 130 } as const;

export type ShutdownSignal = keyof typeof EXIT_CODES;

/** 只依赖 unref：定时器句柄的其余能力这里用不到 */
interface TimerHandle {
  unref(): void;
}

export interface ShutdownGuardDeps {
  onSignal(signal: ShutdownSignal, handler: () => void): void;
  setTimer(fn: () => void, ms: number): TimerHandle;
  exit(code: number): void;
  /** 宽限期覆盖（测试注入）；缺省 SHUTDOWN_GRACE_MS */
  graceMs?: number;
}

/**
 * 宽限期的环境变量覆盖（`PANEL_SHUTDOWN_GRACE_MS`）：非正数 / 非数字 / 未设置
 * 一律返回 null 交由调用方回落默认值——关机路径上的配置读错不该让面板起不来。
 * 存在的意义主要是排障：把它调大就能判断"进程是被兜底定时器结束的，
 * 还是 Next 自己收尾完成的"。
 */
export function parseGraceMs(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function createShutdownGuard(deps: ShutdownGuardDeps): { install(): void } {
  let installed = false;
  let armed = false;

  return {
    install() {
      if (installed) return; // 幂等：register() 理论上可能被调多次，监听器不该叠加
      installed = true;
      for (const signal of Object.keys(EXIT_CODES) as ShutdownSignal[]) {
        deps.onSignal(signal, () => {
          // 一次关机只装一个定时器：首个信号定下退出码，后到的信号
          // （如 docker stop 之后用户又按 Ctrl-C）不重置计时也不改写码
          if (armed) return;
          armed = true;
          const timer = deps.setTimer(
            () => deps.exit(EXIT_CODES[signal]),
            deps.graceMs ?? SHUTDOWN_GRACE_MS,
          );
          // unref：Next 若已顺利收尾，事件循环排空就该立刻退出，
          // 这个兜底定时器自己不能成为进程退不出的新理由
          timer.unref();
        });
      }
    },
  };
}

/**
 * 生产接线：把 node 的进程 API 接到守卫上。
 *
 * 这些 `process.on` / `process.exit` 调用必须住在**服务端模块**里而不是
 * instrumentation.ts：后者会被 Turbopack 纳入 Edge Runtime 的静态分析，
 * 即便运行时已按 NEXT_RUNTIME 分支挡掉，词法上出现的 node API 仍会各报一条
 * "not supported in the Edge Runtime" 警告。挪进这里后 instrumentation.ts
 * 只剩一个 nodejs 分支下的动态 import，警告随之消失。
 */
export function installShutdownGuard(): void {
  const graceMs = parseGraceMs(process.env.PANEL_SHUTDOWN_GRACE_MS);
  createShutdownGuard({
    onSignal: (signal, handler) => {
      process.on(signal, handler);
    },
    setTimer: (fn, ms) => setTimeout(fn, ms),
    exit: (code) => process.exit(code),
    ...(graceMs !== null ? { graceMs } : {}),
  }).install();
}
