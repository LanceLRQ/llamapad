import { readFile } from "node:fs/promises";
import type Database from "better-sqlite3";
import {
  getHostNetIfacePreference,
  HOST_NET_DEV_PATH,
  HOST_NET_ROUTE_PATH,
  listPhysicalIfaces,
  parseNetDev,
  resolveHostIface,
} from "./hostNet";

/**
 * 宿主机网卡设置快照（追加需求 2026-08-27）：设置页区块 + GET/PUT
 * /api/v1/settings/host-net 的共享逻辑，模式对齐 hf/settings.ts——Next.js
 * 路由文件只允许 handler/段配置导出，设置页 SSR 需要同一份快照逻辑，
 * 因此提纯到独立模块供双端共用。
 *
 * 与 hostNet.ts 的纯函数层不同，本文件做真实 /proc 读取（impure），
 * 选卡判定本身仍全部委托给 hostNet.ts（已单测覆盖），这里只负责组装。
 */

export interface HostNetSettingsSnapshot {
  /** 用户设置的原始偏好（"auto" 或具体网卡名） */
  preference: string;
  /** 当前实际生效的网卡（自动选卡结果，或用户指定但已回落时的结果）；
   *  /proc 未挂载时为 null */
  resolvedIface: string | null;
  /** 过滤掉虚拟网卡后的物理网卡列表，供设置页下拉框选用 */
  availableIfaces: string[];
}

async function readProcFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null; // 未挂载 /proc：availableIfaces 降级为空、resolvedIface 为 null
  }
}

/** 读出当前网卡设置快照（GET 路由与设置页 SSR 共用；无副作用） */
export async function getHostNetSettingsSnapshot(db: Database.Database): Promise<HostNetSettingsSnapshot> {
  const preference = getHostNetIfacePreference(db);
  const netDevText = await readProcFile(HOST_NET_DEV_PATH);
  const traffic = netDevText !== null ? parseNetDev(netDevText) : {};
  const routeText = await readProcFile(HOST_NET_ROUTE_PATH);
  const resolvedIface = netDevText !== null ? resolveHostIface(preference, routeText, traffic) : null;
  return { preference, resolvedIface, availableIfaces: listPhysicalIfaces(traffic) };
}
