/**
 * Next 启动钩子（`register()` 在每个 server 实例启动时跑一次）。
 * 目前只装关机兜底——理由与代价见 server/shutdownGuard.ts 头注释。
 *
 * 这里刻意只留一个动态 import：进程信号相关的 node API 全部住在被引入的
 * 服务端模块里，否则 Turbopack 会把它们当作 Edge Runtime 代码逐条告警。
 */
export async function register(): Promise<void> {
  // edge runtime 没有进程信号，也不是面板的运行形态，直接跳过
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { installShutdownGuard } = await import("./server/shutdownGuard");
  installShutdownGuard();
}
