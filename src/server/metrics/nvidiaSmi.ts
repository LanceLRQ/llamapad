import { execFile as execFileCb } from "node:child_process";
import { METRIC_IDS, type Sample } from "./ids";

/**
 * nvidia-smi 采集器（M3 Task 2）
 *
 * 特性探测降级：无 NVIDIA 环境（nvidia-smi ENOENT）的机器上 probe 一次
 * 得 available:false，此后 tick 直接空转，不再起子进程；probe 也可在
 * 运行中由失败的 tick 触发翻 false（nvidia-smi 消失等异常）。
 * 重探策略（如每小时一次）留 M4 真机评估——本机（Mac Docker Desktop）
 * 无 --gpus 支持，探测失败是常态，频繁重探只是白起进程。
 *
 * 采集：nvidia-smi --query-gpu=memory.used,utilization.gpu
 * --format=csv,noheader,nounits → 每行 "mem, util" → gpu.mem_used_mib +
 * gpu.util_percent 两个样本；数值解析坏行（N/A / 空行 / 缺列）跳过。
 */

/** nvidia-smi 查询参数（单次调用同时拿显存与利用率） */
const QUERY_ARGS = [
  "--query-gpu=memory.used,utilization.gpu",
  "--format=csv,noheader,nounits",
] as const;

/** execFile 注入形态（测试 mock 用；缺省 node child_process 的 execFile） */
export type ExecFileLike = (
  command: string,
  args: string[],
  callback: (error: Error | null, stdout: string) => void,
) => unknown;

export interface NvidiaSmiDeps {
  execFile?: ExecFileLike;
}

export interface NvidiaSmiCollector {
  /** 特性探测：nvidia-smi 可用与否（ENOENT/任何失败都算不可用） */
  probe(): Promise<{ available: boolean }>;
  /** 一轮采集：available 才执行 nvidia-smi，每行 CSV 两个样本 */
  tick(): Promise<Sample[]>;
  /** 当前可用性（probe 过才有意义；未 probe 恒 false） */
  isAvailable(): boolean;
}

/** 严格数值解析：整数/小数字面量才认（Number("") === 0 会把空列当 0，须排除） */
function parseCsvNumber(text: string): number {
  return /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : Number.NaN;
}

export function createNvidiaSmiCollector(deps: NvidiaSmiDeps = {}): NvidiaSmiCollector {
  const execFile: ExecFileLike = deps.execFile ?? execFileCb;
  let available = false;

  /** 跑一次 nvidia-smi；任何错误（含 ENOENT）都折叠为 { ok:false }，不抛 */
  function run(): Promise<{ ok: true; stdout: string } | { ok: false }> {
    return new Promise((resolve) => {
      try {
        execFile("nvidia-smi", [...QUERY_ARGS], (error, stdout) => {
          resolve(error !== null ? { ok: false } : { ok: true, stdout });
        });
      } catch {
        resolve({ ok: false }); // 同步抛（极少见）也按失败折叠
      }
    });
  }

  return {
    async probe() {
      const result = await run();
      available = result.ok;
      return { available };
    },

    async tick() {
      if (!available) return [];
      const result = await run();
      if (!result.ok) {
        available = false; // 运行中失败 → 降级，后续轮空转
        return [];
      }

      const now = Date.now();
      const samples: Sample[] = [];
      for (const rawLine of result.stdout.split("\n")) {
        const parts = rawLine.split(",").map((part) => part.trim());
        if (parts.length < 2) continue; // 空行 / 缺列
        const memUsedMib = parseCsvNumber(parts[0]!);
        const utilPercent = parseCsvNumber(parts[1]!);
        if (!Number.isFinite(memUsedMib) || !Number.isFinite(utilPercent)) continue; // 坏行
        samples.push({ metric: METRIC_IDS.gpuMemUsedMib, value: memUsedMib, ts: now });
        samples.push({ metric: METRIC_IDS.gpuUtilPercent, value: utilPercent, ts: now });
      }
      return samples;
    },

    isAvailable() {
      return available;
    },
  };
}
