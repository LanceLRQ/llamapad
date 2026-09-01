import os from "node:os";
import { readFile, statfs } from "node:fs/promises";
import type Database from "better-sqlite3";
import {
  getHostNetIfacePreference,
  HOST_NET_DEV_PATH,
  HOST_NET_ROUTE_PATH,
  parseNetDev,
  resolveHostIface,
} from "./hostNet";
import { diffDiskRate, HOST_DISKSTATS_PATH, isPhysicalDisk, parseDiskstats, type DiskCounterSnapshot } from "./hostDisk";
import { METRIC_IDS, type Sample } from "./ids";

/**
 * 宿主机指标采集器（G4：容器视角 8 项指标之外，补宿主机 CPU/内存/负载/磁盘/
 * 网络——容器 CPU 30% 但宿主机 95%（别的进程在抢资源）时，容器视角完全看
 * 不出来）。
 *
 * 读的是 /proc 与 os.* 系统调用，比 docker stats 还便宜，因此不像 GPU 走
 * 子进程常驻流——直接自带一条 1s 内部定时器（形态对齐 collector.ts 现有的
 * 容器 followStats 订阅：单一数据源，同时喂"秒级快照"与常规 5s 心跳的 ring/
 * 桶，而不是 nvidia 那种"5s 独立查询 + 1s 常驻流两条数据源并存"的模式）。
 *
 * 差分是本模块唯一的新算法，三处：
 * - CPU 利用率：os.cpus() 两次采样的 times 累计差分（idle 增量 / 总增量）
 * - 网络速率：选中网卡的累计字节计数器差分（计数器会回绕/重置，见 diffNetRate）
 * - 磁盘 IO 速率（任务 12，D2）：全部物理盘（过滤规则见 hostDisk.ts）读/写
 *   扇区累计求和后差分，形状与网络速率完全同构（见 diffDiskRate）——磁盘不
 *   像网络要"选一块网卡"，是"对全部物理盘求和"，所以基线只需要一份聚合后的
 *   计数器快照，不用像网络那样连 iface 一起记（切网卡才需要识别"基线是不是
 *   同一个源"，磁盘集合固定，没有这个问题）
 * 首轮只有一次读数、没有基线，三者都算不出来——与 docker stats 流跳首帧
 * （precpu_stats 为空）同理，整轮不产帧，只记基线，下一轮（1s 后）自然补上。
 * 网络/磁盘单独失效（对应 /proc 路径未挂载、网络选不出网卡/磁盘选不出物理盘）
 * 不牵连其余指标——只是该轮对应字段缺席，帧本身照常产出。
 */

// ---------- 纯函数：CPU 利用率差分 ----------

/** CPU 累计时间快照（各核 times 求和），diffCpuPercent 的输入形态 */
export interface CpuTimesSnapshot {
  idleMs: number;
  totalMs: number;
}

/** os.cpus() → 多核累计快照；total = user+nice+sys+idle+irq（Node times 的全部字段） */
export function summarizeCpuTimes(cpus: readonly os.CpuInfo[]): CpuTimesSnapshot {
  let idleMs = 0;
  let totalMs = 0;
  for (const cpu of cpus) {
    idleMs += cpu.times.idle;
    totalMs += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }
  return { idleMs, totalMs };
}

/**
 * CPU 利用率差分：idle 增量 / 总增量 = 空闲率，100 - 空闲率×100 = 利用率。
 * 总时间未增长（时钟未走 / 重复采样）→ null，不产伪造的 0% 或 100%。
 */
export function diffCpuPercent(prev: CpuTimesSnapshot, curr: CpuTimesSnapshot): number | null {
  const totalDelta = curr.totalMs - prev.totalMs;
  if (totalDelta <= 0) return null;
  const idleDelta = curr.idleMs - prev.idleMs;
  const idleRatio = idleDelta / totalDelta;
  return Math.max(0, Math.min(100, (1 - idleRatio) * 100));
}

// ---------- 纯函数：网络字节差分 ----------

/** 网络计数器快照，diffNetRate 的输入形态 */
export interface NetCounterSnapshot {
  rxBytes: number;
  txBytes: number;
  ts: number;
}

export interface NetRate {
  rxBytesPerSec: number;
  txBytesPerSec: number;
}

/**
 * 网络字节差分：计数器会回绕/重置（网卡重置、容器重建）——当前值小于上次
 * 视为重置，不产负数速率，只更新基线（调用方无论是否拿到 rate，都要把
 * curr 存为下一轮的 prev，本函数不负责持有状态）。
 */
export function diffNetRate(prev: NetCounterSnapshot, curr: NetCounterSnapshot): NetRate | null {
  const dtSec = (curr.ts - prev.ts) / 1000;
  if (dtSec <= 0) return null;
  if (curr.rxBytes < prev.rxBytes || curr.txBytes < prev.txBytes) return null;
  return {
    rxBytesPerSec: (curr.rxBytes - prev.rxBytes) / dtSec,
    txBytesPerSec: (curr.txBytes - prev.txBytes) / dtSec,
  };
}

// ---------- 采集编排 ----------

/** 默认 1s 节拍：与 nvidia 常驻流同节拍，但这里没有子进程，就是普通定时器 */
const DEFAULT_INTERVAL_MS = 1_000;

async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null; // 未挂载 /proc 等失败：静默降级，不刷错误日志（默认部署形态）
  }
}

async function statDiskOrNull(root: string): Promise<{ freeBytes: number; totalBytes: number } | null> {
  try {
    // 与 doctor.ts / downloader.ts checkDiskSpace / fsScanner.ts getDiskUsage
    // 同款 statfs 公式：bavail×bsize = 剩余，blocks×bsize = 总量
    const st = await statfs(root);
    return { freeBytes: st.bavail * st.bsize, totalBytes: st.blocks * st.bsize };
  } catch {
    return null;
  }
}

export interface HostStatsDeps {
  /** 读用户网卡偏好（settings 表 host_net_iface，缺省 "auto"） */
  db: Database.Database;
  /** models 根路径：disk 指标的 statfs 对象；未提供则不产磁盘样本 */
  modelsRoot?: string;
  now?: () => number;
  cpus?: () => os.CpuInfo[];
  totalmem?: () => number;
  freemem?: () => number;
  loadavg?: () => number[];
  /** 测试注入点：/host/proc/1/net/dev 读取（缺省真实文件系统，失败→null） */
  readNetDev?: () => Promise<string | null>;
  /** 测试注入点：/host/proc/1/net/route 读取，同上失败语义 */
  readNetRoute?: () => Promise<string | null>;
  /** 测试注入点：models 根所在分区 statfs；缺省真实实现（modelsRoot 未提供时恒 null） */
  statDisk?: () => Promise<{ freeBytes: number; totalBytes: number } | null>;
  /** 测试注入点：/host/proc/diskstats 读取（缺省真实文件系统，失败→null），
   *  磁盘 IO 速率的数据源；与 disk_free_bytes 走的 statDisk 是两条独立读取——
   *  一个是 models 根分区的空间占用，一个是全部物理盘的累计 IO 计数器 */
  readDiskstats?: () => Promise<string | null>;
  /** 内部采样间隔（毫秒），默认 1000 */
  intervalMs?: number;
}

/** 一轮采样的完整帧：cpuPercent 非空即代表本轮"产帧"（见文件头首轮跳过说明） */
interface HostFrame {
  ts: number;
  cpuPercent: number;
  memUsedBytes: number;
  memPercent: number;
  load1: number;
  diskFreeBytes: number | null;
  netRxBytesPerSec: number | null;
  netTxBytesPerSec: number | null;
  diskReadBytesPerSec: number | null;
  diskWriteBytesPerSec: number | null;
  cpuCount: number;
  memTotalBytes: number;
  diskTotalBytes: number | null;
}

export interface HostStatsCollector {
  /** 启动 1s 内部定时器（幂等） */
  start(): void;
  /** 停止定时器（幂等） */
  stop(): void;
  /** 5s 心跳读取：换算最近一帧为 Sample[]（尚无帧 → []）；async 签名对齐
   *  dockerStats/health/nvidia 的 tick()，collector.ts 的心跳循环同构处理四者 */
  tick(): Promise<Sample[]>;
  /** 秒级快照透传（collector.ts 的 latestFastSamples 合并用） */
  latestFastSamples(): { [metric: string]: { value: number; ts: number } };
  /** 分母：CPU 核数/内存总量/磁盘总量（尚未采到 → null） */
  denominators(): { cpuCount: number | null; memTotalBytes: number | null; diskTotalBytes: number | null };
}

function frameToSamples(frame: HostFrame): Sample[] {
  const samples: Sample[] = [
    { metric: METRIC_IDS.hostCpuPercent, value: frame.cpuPercent, ts: frame.ts },
    { metric: METRIC_IDS.hostMemUsedBytes, value: frame.memUsedBytes, ts: frame.ts },
    { metric: METRIC_IDS.hostMemPercent, value: frame.memPercent, ts: frame.ts },
    { metric: METRIC_IDS.hostLoad1, value: frame.load1, ts: frame.ts },
  ];
  if (frame.diskFreeBytes !== null) {
    samples.push({ metric: METRIC_IDS.hostDiskFreeBytes, value: frame.diskFreeBytes, ts: frame.ts });
  }
  if (frame.netRxBytesPerSec !== null) {
    samples.push({ metric: METRIC_IDS.hostNetRxBytesPerSec, value: frame.netRxBytesPerSec, ts: frame.ts });
  }
  if (frame.netTxBytesPerSec !== null) {
    samples.push({ metric: METRIC_IDS.hostNetTxBytesPerSec, value: frame.netTxBytesPerSec, ts: frame.ts });
  }
  if (frame.diskReadBytesPerSec !== null) {
    samples.push({ metric: METRIC_IDS.hostDiskReadBytesPerSec, value: frame.diskReadBytesPerSec, ts: frame.ts });
  }
  if (frame.diskWriteBytesPerSec !== null) {
    samples.push({ metric: METRIC_IDS.hostDiskWriteBytesPerSec, value: frame.diskWriteBytesPerSec, ts: frame.ts });
  }
  return samples;
}

export function createHostStatsCollector(deps: HostStatsDeps): HostStatsCollector {
  const clock = deps.now ?? Date.now;
  const cpus = deps.cpus ?? (() => os.cpus());
  const totalmem = deps.totalmem ?? os.totalmem;
  const freemem = deps.freemem ?? os.freemem;
  const loadavg = deps.loadavg ?? os.loadavg;
  const readNetDev = deps.readNetDev ?? (() => readFileOrNull(HOST_NET_DEV_PATH));
  const readNetRoute = deps.readNetRoute ?? (() => readFileOrNull(HOST_NET_ROUTE_PATH));
  const statDisk =
    deps.statDisk ?? (deps.modelsRoot !== undefined ? () => statDiskOrNull(deps.modelsRoot!) : async () => null);
  const readDiskstats = deps.readDiskstats ?? (() => readFileOrNull(HOST_DISKSTATS_PATH));
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;

  let prevCpu: CpuTimesSnapshot | null = null;
  let prevNet: { iface: string; counters: NetCounterSnapshot } | null = null;
  // 磁盘不像网络要"选一块网卡"（对全部物理盘求和，集合本身不存在切换语义），
  // 基线只需一份聚合后的计数器快照，不用像 prevNet 那样连身份一起记
  let prevDisk: DiskCounterSnapshot | null = null;
  let latest: HostFrame | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;

  async function sampleOnce(): Promise<void> {
    const ts = clock();

    const cpuList = cpus();
    const cpuSnapshot = summarizeCpuTimes(cpuList);
    const cpuPercent = prevCpu !== null ? diffCpuPercent(prevCpu, cpuSnapshot) : null;
    prevCpu = cpuSnapshot;

    const totalMem = totalmem();
    const freeMem = freemem();
    const memUsedBytes = totalMem - freeMem;
    const memPercent = totalMem > 0 ? (memUsedBytes / totalMem) * 100 : 0;
    const load1 = loadavg()[0] ?? 0;

    const disk = await statDisk();

    // 网络：读数/选卡/差分与 CPU 是否产帧无关——即便本轮因 CPU 跳过整帧，
    // 网络基线也照常记录，不会因此多等一轮（见文件头"网络单独失效不牵连"）
    let netRxBytesPerSec: number | null = null;
    let netTxBytesPerSec: number | null = null;
    const netDevText = await readNetDev();
    if (netDevText !== null) {
      const traffic = parseNetDev(netDevText);
      const netRouteText = await readNetRoute();
      const preference = getHostNetIfacePreference(deps.db);
      const iface = resolveHostIface(preference, netRouteText, traffic);
      const counters =
        iface !== null && traffic[iface] !== undefined
          ? { rxBytes: traffic[iface].rxBytes, txBytes: traffic[iface].txBytes, ts }
          : null;
      if (counters !== null) {
        if (prevNet !== null && prevNet.iface === iface) {
          const rate = diffNetRate(prevNet.counters, counters);
          if (rate !== null) {
            netRxBytesPerSec = rate.rxBytesPerSec;
            netTxBytesPerSec = rate.txBytesPerSec;
          }
        }
        prevNet = { iface: iface!, counters };
      } else {
        prevNet = null; // 选不出网卡（只剩虚拟网卡等）：清基线，下次可选出时重新起算
      }
    } else {
      prevNet = null; // /proc 未挂载：清基线，等下次可读时重新起算
    }

    // 磁盘 IO：全部物理盘读/写扇区求和后差分，失败降级口径对齐网络——
    // /proc 未挂载或选不出物理盘都只清基线、不牵连其余字段
    let diskReadBytesPerSec: number | null = null;
    let diskWriteBytesPerSec: number | null = null;
    const diskstatsText = await readDiskstats();
    if (diskstatsText !== null) {
      let readSectors = 0;
      let writeSectors = 0;
      let hasPhysicalDisk = false;
      for (const entry of parseDiskstats(diskstatsText)) {
        if (!isPhysicalDisk(entry.device)) continue;
        hasPhysicalDisk = true;
        readSectors += entry.readSectors;
        writeSectors += entry.writeSectors;
      }
      if (hasPhysicalDisk) {
        const counters: DiskCounterSnapshot = { readSectors, writeSectors, ts };
        if (prevDisk !== null) {
          const rate = diffDiskRate(prevDisk, counters);
          if (rate !== null) {
            diskReadBytesPerSec = rate.readBytesPerSec;
            diskWriteBytesPerSec = rate.writeBytesPerSec;
          }
        }
        prevDisk = counters;
      } else {
        prevDisk = null; // 选不出物理盘（只剩 loop/dm 等虚拟设备）：清基线，下次可选出时重新起算
      }
    } else {
      prevDisk = null; // /proc 未挂载：清基线，等下次可读时重新起算
    }

    if (cpuPercent === null) {
      latest = null; // 首轮（或 CPU 时钟异常）不产帧；上面的基线已经记好
      return;
    }

    latest = {
      ts,
      cpuPercent,
      memUsedBytes,
      memPercent,
      load1,
      diskFreeBytes: disk?.freeBytes ?? null,
      netRxBytesPerSec,
      netTxBytesPerSec,
      diskReadBytesPerSec,
      diskWriteBytesPerSec,
      cpuCount: cpuList.length,
      memTotalBytes: totalMem,
      diskTotalBytes: disk?.totalBytes ?? null,
    };
  }

  return {
    start() {
      if (timer !== undefined) return;
      timer = setInterval(() => void sampleOnce(), intervalMs);
    },
    stop() {
      if (timer === undefined) return;
      clearInterval(timer);
      timer = undefined;
    },
    async tick() {
      return latest === null ? [] : frameToSamples(latest);
    },
    latestFastSamples() {
      if (latest === null) return {};
      const result: { [metric: string]: { value: number; ts: number } } = {};
      for (const sample of frameToSamples(latest)) result[sample.metric] = { value: sample.value, ts: sample.ts };
      return result;
    },
    denominators() {
      return {
        cpuCount: latest?.cpuCount ?? null,
        memTotalBytes: latest?.memTotalBytes ?? null,
        diskTotalBytes: latest?.diskTotalBytes ?? null,
      };
    },
  };
}
