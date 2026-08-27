/**
 * 运行历史展示格式化（U17 T4 走查修复）：从 monitoring/run-history.tsx 提出
 * 独立成纯函数——`formatPeakNetMib` 算的是 U17 的核心口径（净增量 = 峰值
 * 显存 - 启动前 baseline），算错则整块历史列表都是错的，必须有单测兜底；
 * `src/app` 下没有测试基础设施（vitest include 只认 src 目录树下的
 * .test.ts 文件，且约定只在 `src/core`、`src/lib` 配同名测试），
 * 纯函数一律搬来这里。
 */

/** 时长紧凑格式：小时级 "2h14m"、分钟级 "43m"（不再带秒）、否则秒级 "28s"；
 *  endedAt 早于 startedAt（时钟回拨等异常）钳到 0，不产生负数 */
export function formatDuration(startedAt: number, endedAt: number): string {
  const totalSeconds = Math.max(0, Math.floor((endedAt - startedAt) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${totalSeconds}s`;
}

/**
 * 峰值显存净增量：peak - baseline 换算 GiB 一位小数。
 *
 * peak 来自 metrics store 的区间聚合、baseline 来自采集器启动前一帧的
 * nvidiaDevices() 读数——两者不同来源、不同采样时刻，理论上 peak >= baseline，
 * 但启动瞬间若旁路 GPU 进程恰好释放显存，或采集抖动，差值可能为负。
 *
 * 负值不 clamp 到 0：0.0 GiB 会让用户误以为"这个模型不占显存"，而负值真正
 * 的含义是"这次读数不可靠、算不出净增量"——两者语义不同，后者必须显示
 * "—"（null）而不是伪造一个看似正常的零。
 *
 * 任一入参为 null → null（调用侧渲染 "—"）。
 */
export function formatPeakNetMib(peak: number | null, baseline: number | null): string | null {
  if (peak === null || baseline === null) return null;
  const netMib = peak - baseline;
  if (netMib < 0) return null;
  return `${(netMib / 1024).toFixed(1)} GiB`;
}
