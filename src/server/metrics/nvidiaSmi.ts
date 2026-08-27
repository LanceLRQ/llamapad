import { execFile as execFileCb, spawn as spawnCb } from "node:child_process";
import { LineSplitter } from "../../core/line-splitter";
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
 *
 * 常驻流（秒级指标采集 代号 B）：startResident() 另起 `stdbuf -oL nvidia-smi
 * ... -lms 1000` 常驻子进程，按行读取并复用上面的 CSV 解析/聚合逻辑，产出
 * 一份"最近一次秒级快照"（latestStreamSample，纯读，不进时序）。这条路径
 * 完全独立于 probe/tick 维护的 available/status/lastFailureAt——常驻进程
 * 起不来（stdbuf 缺失）、中途异常退出，都只是静默放弃这份秒级快照，
 * 现有三态探测与 60s 重探节流一行不受影响，面板照常拿 5s 心跳的值兜底。
 * nvidia-smi 不是按 JSON 帧分行的：`-lms 1000` 每拍连续吐 N 行（每卡一行，
 * 无头无计数，行与行之间几乎无间隔），故按"停止来新行"做防抖分批
 * （BATCH_DEBOUNCE_MS，远小于两拍间的 ~1s 间隔）：同一拍的 N 行会在防抖
 * 窗口内连续到达，窗口到期即视为该拍收尾，一次性聚合，不与下一拍的行混合。
 *
 * 常驻流自愈（同一单向闸门问题在新路径上的复现修复）：exit/error 只清自己
 * 的引用是不够的——没人会再调 startResident()，常驻进程一旦异常退出，秒级
 * 快照就永久停在最后一帧，等同于本文件开头那个"重探节流"要解决的问题在
 * 常驻流这条新路径上又长了一遍。做法沿用同一范式：exit/error 记一个
 * residentRetryNotBeforeAt（= clock() + RESIDENT_RETRY_INTERVAL_MS），
 * startResident() 开头除幂等判断外，未到该时刻也直接返回；调用方
 * （collector.ts 的 5s tick）每轮都无条件调一次 startResident()，在跑时
 * 幂等空转，死了则在节流窗口后自愈重新 spawn——不会退化成每 5s 重新
 * spawn 一次（那才是节流要防的"退出风暴"）。stopResident() 显式停止会
 * 清空该时刻，紧接着的 startResident() 不应被上一次"异常"的节流拖住。
 */

/** nvidia-smi 查询参数（单次调用同时拿显存/利用率/温度/功耗，六列覆盖分卡明细） */
const QUERY_ARGS = [
  "--query-gpu=index,memory.used,memory.total,utilization.gpu,temperature.gpu,power.draw",
  "--format=csv,noheader,nounits",
] as const;

/** 重探节流间隔：5s 心跳 × 12 = 60s。nvidia-smi 的瞬时抖动通常很快恢复，
 * 60s 足够快地自愈；无 NVIDIA 的机器上每分钟一次 ENOENT 子进程开销可忽略 */
const RETRY_INTERVAL_MS = 60_000;

/** 常驻流拍数：与 -lms 1000 对应，真机实测节拍恒 1.001s */
const RESIDENT_INTERVAL_MS = 1_000;

/** 常驻流退出/失败后的重试节流间隔：与单次 nvidia-smi 重探同量级（RETRY_INTERVAL_MS）。
 * collector 每 5s tick 都会调一次 startResident()，没有这道节流，常驻进程一旦
 * 异常退出就会被每 5s 重新 spawn 一次，形成退出风暴 */
const RESIDENT_RETRY_INTERVAL_MS = RETRY_INTERVAL_MS;

/** 常驻流分批防抖窗口：远小于 1s 拍间隔，足够让同一拍的 N 行连续到达后再聚合 */
const BATCH_DEBOUNCE_MS = 50;

/** 探测状态：probing = 尚未有结论（前端应保持中立，既不显示 GPU 卡也不报不可用） */
export type NvidiaStatus = "probing" | "available" | "unavailable";

/** execFile 注入形态（测试 mock 用；缺省 node child_process 的 execFile） */
export type ExecFileLike = (
  command: string,
  args: string[],
  callback: (error: Error | null, stdout: string) => void,
) => unknown;

/** 常驻子进程的最小形态（真实实现用 node child_process 的 spawn 结果结构兼容） */
export interface ChildProcessLike {
  stdout: NodeJS.ReadableStream | null;
  on(event: "error", listener: (err: Error) => void): void;
  on(event: "exit", listener: (code: number | null) => void): void;
  kill(): void;
}

/** spawn 注入形态（测试 mock 用；缺省 node child_process 的 spawn） */
export type SpawnLike = (command: string, args: string[]) => ChildProcessLike;

export interface NvidiaSmiDeps {
  execFile?: ExecFileLike;
  /** 测试注入点：时间来源（缺省 Date.now），重探节流计时用 */
  now?: () => number;
  /** 测试注入点：常驻子进程的启动方式（缺省 node child_process 的 spawn） */
  spawn?: SpawnLike;
}

/** 秒级快照：常驻流单拍聚合结果（与时序样本同款 sum/avg 公式，独立于 tick 的 ring 输出） */
export interface GpuStreamSample {
  memUsedMib: number;
  utilPercent: number;
  ts: number;
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
  /** 启动常驻子进程采集秒级快照（幂等）；stdbuf 缺失/spawn 失败都静默放弃 */
  startResident(): void;
  /** 停止常驻子进程（幂等），面板进程退出前必须调用避免孤儿 */
  stopResident(): void;
  /** 常驻流最近一拍的聚合快照；从未产出过 → null */
  latestStreamSample(): GpuStreamSample | null;
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

/**
 * 解析一批 CSV 文本（一行一张卡，noheader）为分卡明细数组；坏行跳过
 * （tick() 单次输出、resident 常驻流单拍聚合共用这份解析，不另写一份）。
 */
function parseGpuCsvLines(text: string): GpuDevice[] {
  const devices: GpuDevice[] = [];
  for (const rawLine of text.split("\n")) {
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
  return devices;
}

/** 分卡明细 → 显存合计（sum）与利用率（avg），供时序样本与秒级快照共用 */
function aggregateGpuDevices(devices: readonly GpuDevice[]): { memUsedSum: number; utilAverage: number } {
  const memUsedSum = devices.reduce((sum, device) => sum + device.memUsedMib, 0);
  const utilAverage = devices.reduce((sum, device) => sum + device.utilPercent, 0) / devices.length;
  return { memUsedSum, utilAverage };
}

export function createNvidiaSmiCollector(deps: NvidiaSmiDeps = {}): NvidiaSmiCollector {
  const execFile: ExecFileLike = deps.execFile ?? execFileCb;
  const spawnFn: SpawnLike = deps.spawn ?? (spawnCb as unknown as SpawnLike);
  const clock = deps.now ?? Date.now;
  let available = false;
  /** 三态状态：与 available 同步维护，probe/tick 每次得到结论时一起赋值 */
  let status: NvidiaStatus = "probing";
  /** 上次失败时刻；null 表示从未失败过（含从未 probe 过） */
  let lastFailureAt: number | null = null;
  /** 最近一次成功采集的分卡快照；全坏行/空输出的 tick 不覆盖它 */
  let lastDevices: GpuDevice[] = [];
  /** 常驻子进程句柄；null 表示未启动/已停止/启动失败 */
  let residentProc: ChildProcessLike | null = null;
  /** 常驻流最近一拍的聚合快照；从未产出过 → null */
  let streamSample: GpuStreamSample | null = null;
  /** 常驻流下次允许重试的时刻；null 表示无节流限制（从未失败过，或刚被
   *  stopResident() 显式清空）。startResident() 幂等判断之后的第二道门槛 */
  let residentRetryNotBeforeAt: number | null = null;
  /** 面板退出钩子只挂一次（每次 startResident 都重挂会在多次重启/重探场景
   *  下累积同名监听器，触发 Node 的 MaxListenersExceededWarning） */
  let exitHookRegistered = false;

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

  /**
   * 常驻流按拍分批（防抖）：同一拍的 N 行（每卡一行）几乎无间隔连续到达，
   * 每收一行就重置计时器，窗口到期无新行即视为该拍收尾，一次性聚合。
   */
  function createResidentBatcher(onBatch: (lines: string[]) => void) {
    let batch: string[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flushNow = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (batch.length > 0) {
        const lines = batch;
        batch = [];
        onBatch(lines);
      }
    };
    return {
      pushLine(line: string): void {
        if (line.trim() === "") return; // 空行噪声，忽略
        batch.push(line);
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(flushNow, BATCH_DEBOUNCE_MS);
      },
      flush(): void {
        flushNow();
      },
    };
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
      const devices = parseGpuCsvLines(result.stdout);

      // 全坏行 / 空输出：不覆盖 lastDevices，避免一次瞬时坏帧抹掉分卡明细
      if (devices.length === 0) return [];

      lastDevices = devices;
      const { memUsedSum, utilAverage } = aggregateGpuDevices(devices);
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

    startResident() {
      if (residentProc !== null) return; // 幂等：已在跑不重复启动
      if (residentRetryNotBeforeAt !== null && clock() < residentRetryNotBeforeAt) return; // 节流：未到重试时刻

      let proc: ChildProcessLike;
      try {
        proc = spawnFn("stdbuf", ["-oL", "nvidia-smi", ...QUERY_ARGS, "-lms", String(RESIDENT_INTERVAL_MS)]);
      } catch {
        // 同步抛出（极少见，如 stdbuf 不在 PATH 时部分平台的行为）：静默放弃，
        // 同样计入节流——调用方（collector 的 5s tick）每轮都会再调一次，
        // 没有这道门槛会变成每 5s 重试一次 spawn
        residentRetryNotBeforeAt = clock() + RESIDENT_RETRY_INTERVAL_MS;
        return;
      }
      residentProc = proc;

      const batcher = createResidentBatcher((lines) => {
        const devices = parseGpuCsvLines(lines.join("\n"));
        if (devices.length === 0) return; // 整拍坏行：不产快照，也不覆盖旧快照
        const { memUsedSum, utilAverage } = aggregateGpuDevices(devices);
        streamSample = { memUsedMib: memUsedSum, utilPercent: utilAverage, ts: clock() };
      });
      const splitter = new LineSplitter((line) => batcher.pushLine(line));

      proc.stdout?.on("data", (chunk: Buffer) => splitter.push(chunk));
      proc.on("error", () => {
        // stdbuf 缺失 / spawn 失败（ENOENT 等）：静默降级。只清自己的引用——
        // stop→start 快速重启后，本回调可能晚于新 proc 才收到旧进程的事件，
        // 不能无条件清空，否则会把刚起来的新句柄一并抹掉；同理，记录重试
        // 时刻也必须在这个守卫内部，是"这次失败"该记的账，不能算到新句柄头上
        if (residentProc === proc) {
          residentProc = null;
          residentRetryNotBeforeAt = clock() + RESIDENT_RETRY_INTERVAL_MS;
        }
      });
      proc.on("exit", () => {
        // 常驻进程异常退出：flush 收尾后清理句柄，记下节流时刻——不自动重启
        // （避免退出风暴），但 collector 的 5s tick 每轮都会调 startResident()，
        // 节流窗口一过就自愈，不会像旧版那样永久停在最后一帧
        batcher.flush();
        if (residentProc === proc) {
          residentProc = null;
          residentRetryNotBeforeAt = clock() + RESIDENT_RETRY_INTERVAL_MS;
        }
      });

      // 面板进程退出前尽力 kill 常驻子进程，避免孤儿；无法覆盖 SIGKILL 等
      // 不可捕获的终止方式，但覆盖了 process.exit() 触发的正常收尾路径。
      // 只挂一次：多次 startResident（重探/重启）不应叠加监听器
      if (!exitHookRegistered) {
        exitHookRegistered = true;
        process.once("exit", () => {
          residentProc?.kill();
        });
      }
    },

    stopResident() {
      if (residentProc === null) return; // 幂等
      residentProc.kill();
      residentProc = null;
      residentRetryNotBeforeAt = null; // 显式停止不是"异常"，紧接着的 startResident() 应立即生效
    },

    latestStreamSample() {
      return streamSample;
    },
  };
}
