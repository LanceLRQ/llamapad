/**
 * 宿主机磁盘 IO 采集（任务 12，D2：磁盘剩余折线变化太慢看不出东西，改看
 * 磁盘读/写速率；host.disk_free_bytes 字段保留不动，本文件只加两个新指标）。
 *
 * 数据源与网络指标同源——compose 已把 /proc:/host/proc:ro 整个挂进容器，
 * PID 1 的 mount namespace 之外单独挂了这一份宿主机 /proc（不像 hostNet.ts
 * 那样还要钻进 /host/proc/1/net/*，diskstats 本身就是全局的，不分 netns）。
 *
 * 三个纯函数，形状照抄 hostNet.ts 的选卡分层（解析 → 判定 → hostStats.ts
 * 里编排差分），差分算法进一步照抄 hostStats.ts 既有的 diffNetRate
 * （回绕/重置保护 + 调用方持有基线），不重新发明另一套语义。
 */

/** 宿主机磁盘计数器路径：与 hostNet.ts 的 HOST_NET_DEV_PATH 同一惯例，
 *  diskstats 是全局视图不挂在某个 pid 下，所以比网络那条路径短一节 */
export const HOST_DISKSTATS_PATH = "/host/proc/diskstats";

/** 单设备累计扇区数，parseDiskstats 的产出单元 */
export interface DiskstatsEntry {
  device: string;
  readSectors: number;
  writeSectors: number;
}

/**
 * 解析 /proc/diskstats：每行 ≥14 个空白分隔字段（major、minor、设备名 + 至少
 * 11 个统计字段，内核文档 1-indexed），本函数只取字段 3（设备名）、
 * 字段 6（读扇区累计）、字段 10（写扇区累计）——真机 `head /proc/diskstats`
 * 实测行位置见 hostDisk.test.ts fixture。字段数不足或扇区字段非数值的行
 * （理论上不该出现，但内核版本差异存在扩展字段，防御性处理）整行跳过。
 */
export function parseDiskstats(text: string): DiskstatsEntry[] {
  const entries: DiskstatsEntry[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10) continue;
    const device = fields[2];
    const readSectors = Number(fields[5]);
    const writeSectors = Number(fields[9]);
    if (device === undefined || device === "") continue;
    if (!Number.isFinite(readSectors) || !Number.isFinite(writeSectors)) continue;
    entries.push({ device, readSectors, writeSectors });
  }
  return entries;
}

/** 虚拟/映射设备前缀：这些设备的统计要么是别的设备的转发（dm-* 与其底层
 *  物理盘重复计数），要么本来就不是物理磁盘（loop/ram/sr），一律排除 */
const VIRTUAL_DEVICE_PREFIXES = ["loop", "ram", "sr", "dm-"];

/**
 * 判定是否为参与求和的物理盘。两类要排除：
 * 1. 虚拟/映射设备（见 VIRTUAL_DEVICE_PREFIXES）
 * 2. 分区行（sda1、nvme0n1p1）——父设备（sda、nvme0n1）的累计值已经包含了
 *    它所有分区的 IO，分区行是同一次物理 IO 在内核里的第二次记账，
 *    连父设备一起求和会让每次 IO 都被算两遍
 *
 * 命名规律照两条内核常见模式区分物理盘与分区：
 * - nvme/mmcblk 这类"数字在设备名中间"的命名，物理盘以数字结尾
 *   （nvme0n1），分区在后面多一段 pN（nvme0n1p1）
 * - sd/hd/vd 这类盘符命名，物理盘是纯字母后缀（sda），分区在字母后加数字
 *   （sda1）
 * 两类模式都不命中的设备名（不是这台机器上会出现的常见磁盘）保守排除，
 * 宁可漏采一块认不出的盘，也不要把未知设备错当物理盘重复计数。
 */
export function isPhysicalDisk(device: string): boolean {
  if (VIRTUAL_DEVICE_PREFIXES.some((prefix) => device.startsWith(prefix))) return false;
  if (/^nvme\d+n\d+$/.test(device)) return true;
  if (/^nvme\d+n\d+p\d+$/.test(device)) return false;
  if (/^mmcblk\d+$/.test(device)) return true;
  if (/^mmcblk\d+p\d+$/.test(device)) return false;
  if (/^(sd|hd|vd|xvd)[a-z]+$/.test(device)) return true;
  if (/^(sd|hd|vd|xvd)[a-z]+\d+$/.test(device)) return false;
  return false;
}

/** 磁盘计数器快照（累计扇区数，非字节），diffDiskRate 的输入形态——
 *  与 hostStats.ts 的 NetCounterSnapshot 同构 */
export interface DiskCounterSnapshot {
  readSectors: number;
  writeSectors: number;
  ts: number;
}

export interface DiskRate {
  readBytesPerSec: number;
  writeBytesPerSec: number;
}

/** /proc/diskstats 的扇区固定 512 字节，内核文档明确写死，不随设备实际
 *  block size 变化（即便是 4K 对齐的盘，diskstats 仍按 512 字节扇区计数） */
const SECTOR_BYTES = 512;

/**
 * 磁盘扇区差分换算字节/秒：与 diffNetRate 同一套回绕/重置保护——当前值小于
 * 上次视为计数器重置（罕见，如内核热插拔重枚举设备号），不产负速率，只更新
 * 基线（调用方无论是否拿到 rate，都要把 curr 存为下一轮的 prev，本函数不
 * 负责持有状态）。
 */
export function diffDiskRate(prev: DiskCounterSnapshot, curr: DiskCounterSnapshot): DiskRate | null {
  const dtSec = (curr.ts - prev.ts) / 1_000;
  if (dtSec <= 0) return null;
  if (curr.readSectors < prev.readSectors || curr.writeSectors < prev.writeSectors) return null;
  return {
    readBytesPerSec: ((curr.readSectors - prev.readSectors) * SECTOR_BYTES) / dtSec,
    writeBytesPerSec: ((curr.writeSectors - prev.writeSectors) * SECTOR_BYTES) / dtSec,
  };
}
