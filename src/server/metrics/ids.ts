/**
 * 指标标识与采样单元（M3 Task 2）
 *
 * 三类采集器（dockerStats / health / nvidiaSmi）统一产出 Sample，
 * 由调度器（collector.ts）喂给 onSample 回调（T3 的 metrics store 消费）。
 * metric 用点分命名空间字符串，UI 侧按前缀分容器 / 推理 / GPU 三组图表。
 */

/** 全部指标 id（字面量锚定，防止采集器与 UI/store 各写一份字符串漂移） */
export const METRIC_IDS = {
  /** 容器 CPU 占用率（%，多核可超 100） */
  containerCpuPercent: "container.cpu_percent",
  /** 容器内存用量（字节） */
  containerMemBytes: "container.mem_bytes",
  /** 容器内存占用率（%，mem/limit×100） */
  containerMemPercent: "container.mem_percent",
  /** 生成速率（tokens/秒，/slots 的 n_decoded 按 slot 差分求和；不含 prompt eval） */
  inferTokensPerSec: "infer.tokens_per_sec",
  /** KV cache 占用（tokens，/slots 处理中 slot 的 n_prompt_tokens+next_token.n_decoded 求和） */
  inferKvCacheTokens: "infer.kv_cache_tokens",
  /** 运行中的 slot 数（/slots 数组中 is_processing===true 计数） */
  inferSlotsRunning: "infer.slots_running",
  /** GPU 显存占用（MiB，nvidia-smi memory.used） */
  gpuMemUsedMib: "gpu.mem_used_mib",
  /** GPU 利用率（%，nvidia-smi utilization.gpu） */
  gpuUtilPercent: "gpu.util_percent",
  /** 宿主机 CPU 占用率（%，os.cpus() 两次采样的 times 差分） */
  hostCpuPercent: "host.cpu_percent",
  /** 宿主机内存已用字节数（os.totalmem() - os.freemem()） */
  hostMemUsedBytes: "host.mem_used_bytes",
  /** 宿主机内存占用率（%） */
  hostMemPercent: "host.mem_percent",
  /** 宿主机 1 分钟平均负载（os.loadavg()[0]）；只存 load1——5/15 分钟值与
   *  时序图本身展示的历史趋势冗余，不重复存储 */
  hostLoad1: "host.load1",
  /** 宿主机磁盘剩余字节数（models 根所在分区，statfs 复用 doctor.ts 同款算法） */
  hostDiskFreeBytes: "host.disk_free_bytes",
  /** 宿主机网络接收速率（字节/秒，选中网卡的累计计数器差分） */
  hostNetRxBytesPerSec: "host.net_rx_bytes_per_sec",
  /** 宿主机网络发送速率（字节/秒，同上） */
  hostNetTxBytesPerSec: "host.net_tx_bytes_per_sec",
  /** 宿主机磁盘读取速率（字节/秒，/proc/diskstats 物理盘读扇区累计差分 ×512） */
  hostDiskReadBytesPerSec: "host.disk_read_bytes_per_sec",
  /** 宿主机磁盘写入速率（字节/秒，同上） */
  hostDiskWriteBytesPerSec: "host.disk_write_bytes_per_sec",
} as const;

/** 指标 id 类型（METRIC_IDS 的值联合） */
export type MetricId = (typeof METRIC_IDS)[keyof typeof METRIC_IDS];

/** 采样点：采集器产出、T3 metrics store 消费的最小单元 */
export interface Sample {
  metric: MetricId;
  value: number;
  /** 采样时间戳（毫秒） */
  ts: number;
}
