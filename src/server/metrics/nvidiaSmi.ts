import { execFile as execFileCb } from "node:child_process";
import { METRIC_IDS, type Sample } from "./ids";

/**
 * nvidia-smi 采集器（M3 Task 2 / M4 真机回归 #8）
 *
 * 特性探测降级：无 NVIDIA 环境（nvidia-smi ENOENT）的机器上 probe 一次
 * 得 available:false；此后 tick 未到重探间隔前空转，不起子进程。
 * probe 也可在运行中由失败的 tick 触发翻 false（nvidia-smi 消失等异常），
 * 失败时刻记入 lastFailureAt，作为重探计时的起点；从未 probe 过时
 * （lastFailureAt 为 null）tick 恒空转，不会主动发起探测。
 *
 * 重探节流：M4 真机实测发现单向闸门代价过大——GPU 满载/驱动忙时
 * nvidia-smi 偶发非 0 退出，一次瞬时失败会永久关闭 GPU 监控，只能重启
 * 面板容器才恢复。故按 RETRY_INTERVAL_MS 周期性重探：available:false 且
 * 到达重探间隔时，tick 会照常跑一次 nvidia-smi，成功即翻回
 * available:true 并正常产出样本，失败则刷新 lastFailureAt、计时窗口
 * 重新起算。
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

/** 重探节流间隔：5s 心跳 × 12 = 60s。nvidia-smi 的瞬时抖动通常很快恢复，
 * 60s 足够快地自愈；无 NVIDIA 的机器上每分钟一次 ENOENT 子进程开销可忽略 */
const RETRY_INTERVAL_MS = 60_000;

/** execFile 注入形态（测试 mock 用；缺省 node child_process 的 execFile） */
export type ExecFileLike = (
  command: string,
  args: string[],
  callback: (error: Error | null, stdout: string) => void,
) => unknown;

export interface NvidiaSmiDeps {
  execFile?: ExecFileLike;
  /** 测试注入点：时间来源（缺省 Date.now），重探节流计时用 */
  now?: () => number;
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
  const clock = deps.now ?? Date.now;
  let available = false;
  /** 上次失败时刻；null 表示从未失败过（含从未 probe 过） */
  let lastFailureAt: number | null = null;

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
      if (!result.ok) lastFailureAt = clock(); // 重探计时从 probe 失败起算
      return { available };
    },

    async tick() {
      if (!available) {
        if (lastFailureAt === null) return []; // 从未 probe 过，tick 不主动探测
        if (clock() - lastFailureAt < RETRY_INTERVAL_MS) return []; // 未到重探间隔，空转
        // 已到重探间隔：当作一次新探测，与下面「可用中」共用同一次 run()
      }

      const result = await run();
      if (!result.ok) {
        available = false; // 维持降级，或重探失败后继续降级
        lastFailureAt = clock(); // 计时窗口从本次失败重新起算
        return [];
      }
      available = true; // 成功：维持可用，或从降级中自愈

      const now = clock();
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
