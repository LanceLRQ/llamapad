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
 * 采集：nvidia-smi --query-gpu=index,memory.used,memory.total,
 * utilization.gpu,temperature.gpu,power.draw --format=csv,noheader,nounits
 * → 每行一张卡。前 4 列（index/memUsed/memTotal/util）为必需，任一解析
 * 失败（N/A / 空行 / 缺列）整行跳过；后 2 列（温度/功耗）允许 N/A 或
 * 整列缺失，退化为 null，不影响整行参与聚合——这两个字段只做分卡展示，
 * 没有它们不该让显存/利用率也跟着丢。
 *
 * 多卡聚合（M5 多卡缺陷修复）：早期实现按行 push 样本，两张卡的值会撞进
 * 同一条时序（metric id 相同），面板只剩"最后一张卡覆盖前面"的假象。
 * 现改为一轮 tick 只产出两个时序样本：gpu.mem_used_mib 取各卡显存求和，
 * gpu.util_percent 取各卡利用率算术平均（不在此处 round，交给 UI 层按需
 * 格式化）。单卡场景下 sum/avg 退化为该卡自身的值，行为与修复前等价。
 *
 * 分卡明细走 devices()，不进时序：温度/功耗这类字段求和或平均没有意义，
 * 只适合原样展示，因此单列一个"最近一次成功采集快照"的读法，与
 * tick() 返回的聚合 Sample 分离。一轮 tick 全部是坏行（或空输出）时
 * tick() 照常返回 []，但 devices() 刻意不清空——一次瞬时坏帧不该让
 * 面板已经显示的分卡明细突然消失，保留上一次成功值直到下一次成功覆盖。
 *
 * 三态 status（M5 Task 4）：isAvailable() 把"尚未探测完"与"探测确认不可用"
 * 都折叠成 false，前端首帧因此无法区分"探测中"与"确认不可用"，会闪现
 * 误导性的红字提示。status() 额外暴露 probing/available/unavailable
 * 三态，与 available 同步维护；isAvailable() 保留不变（仍有调用方依赖
 * "当前能不能采"这个二态语义）。
 */

/** nvidia-smi 查询参数（单次调用同时拿显存/利用率/温度/功耗，六列覆盖分卡明细） */
const QUERY_ARGS = [
  "--query-gpu=index,memory.used,memory.total,utilization.gpu,temperature.gpu,power.draw",
  "--format=csv,noheader,nounits",
] as const;

/** 重探节流间隔：5s 心跳 × 12 = 60s。nvidia-smi 的瞬时抖动通常很快恢复，
 * 60s 足够快地自愈；无 NVIDIA 的机器上每分钟一次 ENOENT 子进程开销可忽略 */
const RETRY_INTERVAL_MS = 60_000;

/** 探测状态：probing = 尚未有结论（前端应保持中立，既不显示 GPU 卡也不报不可用） */
export type NvidiaStatus = "probing" | "available" | "unavailable";

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

/** 单卡快照（分卡明细，不进时序；tempC/powerW 不可解析时为 null） */
export interface GpuDevice {
  index: number;
  memUsedMib: number;
  memTotalMib: number;
  utilPercent: number;
  tempC: number | null;
  powerW: number | null;
}

export interface NvidiaSmiCollector {
  /** 特性探测：nvidia-smi 可用与否（ENOENT/任何失败都算不可用） */
  probe(): Promise<{ available: boolean }>;
  /** 一轮采集：available 才执行 nvidia-smi，各卡 CSV 聚合为两个时序样本 */
  tick(): Promise<Sample[]>;
  /** 当前可用性（probe 过才有意义；未 probe 恒 false） */
  isAvailable(): boolean;
  /** 三态探测状态：probing（尚无结论）/ available / unavailable */
  status(): NvidiaStatus;
  /** 最近一次成功采集的分卡快照；从未成功采集过 → [] */
  devices(): GpuDevice[];
}

/** 严格数值解析：整数/小数字面量才认（Number("") === 0 会把空列当 0，须排除） */
function parseCsvNumber(text: string): number {
  return /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : Number.NaN;
}

/** 可选列解析：整列缺失（undefined）或 N/A/空串都算不可解析 → null，
 * 与必需列不同，不会因此让整行判负 */
function parseOptionalCsvNumber(text: string | undefined): number | null {
  if (text === undefined) return null;
  const value = parseCsvNumber(text);
  return Number.isFinite(value) ? value : null;
}

export function createNvidiaSmiCollector(deps: NvidiaSmiDeps = {}): NvidiaSmiCollector {
  const execFile: ExecFileLike = deps.execFile ?? execFileCb;
  const clock = deps.now ?? Date.now;
  let available = false;
  /** 三态状态：与 available 同步维护，probe/tick 每次得到结论时一起赋值 */
  let status: NvidiaStatus = "probing";
  /** 上次失败时刻；null 表示从未失败过（含从未 probe 过） */
  let lastFailureAt: number | null = null;
  /** 最近一次成功采集的分卡快照；全坏行/空输出的 tick 不覆盖它 */
  let lastDevices: GpuDevice[] = [];

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
      status = result.ok ? "available" : "unavailable";
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
        status = "unavailable";
        lastFailureAt = clock(); // 计时窗口从本次失败重新起算
        return [];
      }
      available = true; // 成功：维持可用，或从降级中自愈
      status = "available";

      const now = clock();
      const devices: GpuDevice[] = [];
      for (const rawLine of result.stdout.split("\n")) {
        const parts = rawLine.split(",").map((part) => part.trim());
        if (parts.length < 4) continue; // 空行 / 必需列缺失
        const index = parseCsvNumber(parts[0]!);
        const memUsedMib = parseCsvNumber(parts[1]!);
        const memTotalMib = parseCsvNumber(parts[2]!);
        const utilPercent = parseCsvNumber(parts[3]!);
        if (
          !Number.isFinite(index) ||
          !Number.isFinite(memUsedMib) ||
          !Number.isFinite(memTotalMib) ||
          !Number.isFinite(utilPercent)
        ) {
          continue; // 必需列有坏值（N/A 等），整行跳过
        }
        // 温度/功耗是可选列：N/A 或整列缺失都退化为 null，不影响这行参与聚合
        const tempC = parseOptionalCsvNumber(parts[4]);
        const powerW = parseOptionalCsvNumber(parts[5]);
        devices.push({ index, memUsedMib, memTotalMib, utilPercent, tempC, powerW });
      }

      // 全坏行 / 空输出：不覆盖 lastDevices，避免一次瞬时坏帧抹掉分卡明细
      if (devices.length === 0) return [];

      lastDevices = devices;
      const memUsedSum = devices.reduce((sum, device) => sum + device.memUsedMib, 0);
      const utilAverage = devices.reduce((sum, device) => sum + device.utilPercent, 0) / devices.length;
      return [
        { metric: METRIC_IDS.gpuMemUsedMib, value: memUsedSum, ts: now },
        { metric: METRIC_IDS.gpuUtilPercent, value: utilAverage, ts: now },
      ];
    },

    isAvailable() {
      return available;
    },

    status() {
      return status;
    },

    devices() {
      return lastDevices;
    },
  };
}
