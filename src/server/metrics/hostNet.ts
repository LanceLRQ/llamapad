import type Database from "better-sqlite3";

/**
 * 宿主机网卡选择（追加需求 2026-08-27）：网络指标不再对所有非 lo 网卡求和——
 * 那样会把 docker0、br- 或 veth 前缀这类虚拟网卡的内部流量也算进去，数字没有意义。
 * 改为选定唯一一块"对外"网卡读取其计数器，选卡支持用户手动指定，默认自动选。
 *
 * 本文件只做纯解析与选卡判定，不碰真实文件系统——真实的 /proc 读取在
 * hostStats.ts（差分编排）与 hostNetSettings.ts（供设置页/GET 接口展示可选
 * 网卡）各自的薄壳里，两处共用这里的解析与选卡函数，保证判定口径一致。
 *
 * 自动选卡判据（真机验证，见 hostNet.test.ts 的双默认路由 fixture）：
 * 1. /proc/net/route 里 Destination 为全零（默认路由）的候选中取 Metric 最小
 * 2. Metric 相同 → 取累计 rx+tx 最大的
 * 3. 无默认路由 / 路由表读不到 → 回落：排除虚拟网卡，剩余里取流量最大者
 * 4. 全都选不出 → null（调用方不产网络样本，语义同"未挂载 /proc"）
 */

/** 宿主机网络计数器路径（node_exporter 同款做法：PID 1 的 netns 即宿主机网络命名空间，
 *  见 compose 的 `/proc:/host/proc:ro` 挂载注释）；hostStats.ts 与设置页路由共用 */
export const HOST_NET_DEV_PATH = "/host/proc/1/net/dev";
export const HOST_NET_ROUTE_PATH = "/host/proc/1/net/route";

/** 单网卡累计流量（parseNetDev 的产出单位，字节） */
export interface IfaceTraffic {
  rxBytes: number;
  txBytes: number;
}

/**
 * 解析 /proc/net/dev：表头两行无冒号，天然被 `indexOf(":") === -1` 挡掉，
 * 不需要单独识别表头。数据行形如
 * `  eth0: 123 4 0 0 0 0 0 0 456 7 0 0 0 0 0 0`——冒号后第 1 个数值是
 * rxBytes，第 9 个（0-indexed 第 8 个）是 txBytes；字段解析失败的行整行跳过。
 */
export function parseNetDev(text: string): Record<string, IfaceTraffic> {
  const result: Record<string, IfaceTraffic> = {};
  for (const line of text.split("\n")) {
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;
    const iface = line.slice(0, colonIndex).trim();
    if (iface === "") continue;
    const fields = line
      .slice(colonIndex + 1)
      .trim()
      .split(/\s+/);
    const rxBytes = Number(fields[0]);
    const txBytes = Number(fields[8]);
    if (!Number.isFinite(rxBytes) || !Number.isFinite(txBytes)) continue;
    result[iface] = { rxBytes, txBytes };
  }
  return result;
}

/** /proc/net/route 单行：Metric 是 1-indexed 第 7 列（列序见文件头注释） */
export interface RouteEntry {
  iface: string;
  destinationHex: string;
  metric: number;
}

/** Destination 全零即默认路由（0.0.0.0），大小端书写不影响这个字符串本身 */
const DEFAULT_ROUTE_DESTINATION = "00000000";

/** 解析 /proc/net/route：首行表头跳过，列数不足或 Metric 非数值的行跳过 */
export function parseNetRoute(text: string): RouteEntry[] {
  const entries: RouteEntry[] = [];
  const lines = text.split("\n").slice(1); // 首行固定表头
  for (const line of lines) {
    if (line.trim() === "") continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 7) continue;
    const metric = Number(parts[6]);
    if (!Number.isFinite(metric)) continue;
    entries.push({ iface: parts[0]!, destinationHex: parts[1]!, metric });
  }
  return entries;
}

/** 虚拟网卡前缀：这些网卡的流量是内部转发/隧道，不代表"对外"吞吐，
 * 自动选卡的回落路径与设置页下拉框都要滤掉 */
const VIRTUAL_IFACE_PREFIXES = ["docker", "br-", "veth", "virbr", "tun", "tap"];

/** lo 精确匹配，其余按前缀判定（如 veth1234、br-abcdef） */
export function isVirtualIface(name: string): boolean {
  return name === "lo" || VIRTUAL_IFACE_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** 自动选卡：判据见文件头注释 */
export function selectAutoIface(
  routeText: string | null,
  traffic: Record<string, IfaceTraffic>,
): string | null {
  if (routeText !== null) {
    const candidates = parseNetRoute(routeText).filter(
      (entry) => entry.destinationHex.toLowerCase() === DEFAULT_ROUTE_DESTINATION,
    );
    let best: RouteEntry | null = null;
    let bestTraffic = -1;
    for (const candidate of candidates) {
      const t = traffic[candidate.iface];
      const candidateTraffic = t !== undefined ? t.rxBytes + t.txBytes : 0;
      if (
        best === null ||
        candidate.metric < best.metric ||
        (candidate.metric === best.metric && candidateTraffic > bestTraffic)
      ) {
        best = candidate;
        bestTraffic = candidateTraffic;
      }
    }
    if (best !== null) return best.iface;
  }

  // 回落：无默认路由 / 路由表读不到——排除虚拟网卡，剩余里取流量最大者
  let fallback: string | null = null;
  let fallbackTraffic = -1;
  for (const [iface, t] of Object.entries(traffic)) {
    if (isVirtualIface(iface)) continue;
    const total = t.rxBytes + t.txBytes;
    if (fallback === null || total > fallbackTraffic) {
      fallback = iface;
      fallbackTraffic = total;
    }
  }
  return fallback;
}

/**
 * 结合用户偏好的最终选卡：偏好非 "auto" 且该网卡当前存在于 traffic（即
 * /proc/net/dev 里能看到）→ 直接用；否则（偏好本就是 auto，或配置的网卡已
 * 消失——USB 网卡拔出、改名等）→ 落回自动选卡，不报错、不产空数据。
 */
export function resolveHostIface(
  preference: string,
  routeText: string | null,
  traffic: Record<string, IfaceTraffic>,
): string | null {
  if (preference !== "auto" && traffic[preference] !== undefined) return preference;
  return selectAutoIface(routeText, traffic);
}

/** 设置页下拉框候选：过滤虚拟网卡与 lo，按名称排序（不含 lo/docker0 这类噪声） */
export function listPhysicalIfaces(traffic: Record<string, IfaceTraffic>): string[] {
  return Object.keys(traffic)
    .filter((name) => !isVirtualIface(name))
    .sort();
}

// ---------- 用户偏好持久化（settings 表，与 hf/settings.ts 的 saveHfMirror 同款 upsert 写法） ----------

/** settings 表键：宿主机网络监控网卡偏好（"auto" 或具体网卡名，缺省即 auto） */
export const HOST_NET_IFACE_SETTING_KEY = "host_net_iface";

/** 读用户偏好；未设置过 → "auto" */
export function getHostNetIfacePreference(db: Database.Database): string {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(HOST_NET_IFACE_SETTING_KEY) as { value: string } | undefined;
  return row?.value ?? "auto";
}

/** 落库用户偏好（upsert，覆盖旧值） */
export function saveHostNetIfacePreference(db: Database.Database, value: string): void {
  db.prepare(
    `INSERT INTO settings(key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(HOST_NET_IFACE_SETTING_KEY, value);
}
