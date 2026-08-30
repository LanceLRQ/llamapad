import type { RangeKey, WindowPayload, WindowPoint } from "@/server/metrics/window";

/**
 * 客户端窗口增量合并（指标窗口增量协议，方案 A）：vitest 是 environment: node
 * 且没装 jsdom，组件测不了，合并逻辑一律下沉到这里（与 chart-format.ts 同层）。
 * 降源判定完全在服务端（server/metrics/window.ts 的 planWindowQuery），本文件
 * 只负责把服务端回的 full/delta 应用到客户端已持有的那份数据上。
 */

/** 合并服务端响应到已持有的载荷。full / range 不一致 / 无历史 → 直接返回 incoming */
export function mergeWindowPayload(held: WindowPayload | null, incoming: WindowPayload): WindowPayload {
  if (incoming.mode === "full") return incoming;
  // held 为空或 range 不一致理论上不会发生（客户端切档时不带 since，
  // 服务端也就不会回 delta），这里是防御性兜底，不是正常路径。
  if (held === null || held.range !== incoming.range) return incoming;

  const series: { [metric: string]: WindowPoint[] } = {};
  for (const [id, freshPoints] of Object.entries(incoming.series)) {
    const kept = (held.series[id] ?? []).filter((p) => p.ts >= incoming.from);
    const lastKeptTs = kept.length > 0 ? kept[kept.length - 1]!.ts : -Infinity;
    // 按本序列自己的末点去重，不用全局水位（nextSince 取的是全体 series
    // 的最大 ts）：hostStats 内部 1s 采样、collector 5s 心跳，各采集器的
    // ts 并非严格对齐，全局水位可能略新于某条慢序列的末点，理论上会让
    // 同一个点被返回两次。逐序列去重可以彻底消除这个可能，副作用是本函数
    // 天然幂等——同一个 delta 应用两次结果不变。
    const fresh = freshPoints.filter((p) => p.ts > lastKeptTs);
    series[id] = kept.concat(fresh);
  }
  return { ...incoming, series };
}

/**
 * 安全边距（两个 collector 心跳，见 server/metrics/collector.ts 的 5s 节拍）：
 * nextSince 拿的是全体 series 的全局最大 ts，但点是逐序列产生的，两者存在
 * 结构性错位——各采集器的滞后并不对齐（真机实测 host.* 比 gpu.* 滞后
 * ~926ms，见指标窗口增量协议缺陷复核）。设某条序列 X 的末点为 T_x，全局
 * 水位为 since（可能来自另一条更靠前的序列），X 相对全局水位的滞后
 * L = since - T_x。X 的下一个点落在 T_x + 5000（一次心跳后），它能被
 * `ts > since` 放行的条件是 T_x + 5000 > since，即 L < 5000——只要某条
 * 序列的滞后达到一整个心跳，它那一轮的点就会被服务端的增量过滤静默跳过，
 * 而且是永久跳过：since 已经推过去了，之后任何一轮都不会再把这个点取回来，
 * 图表上表现为一个不声不响的缺口。
 *
 * 用「全局最大 ts - 两个心跳」当水位可以把这条不变量的容忍范围从「小于
 * 1 个心跳」放宽到「小于 3 个心跳」（10s 边距 + 5s 心跳本身），代价只是
 * 多问服务端要回最近两个心跳的点——这些点会被 mergeWindowPayload 里逐
 * 序列的 `p.ts > lastKeptTs` 去重掉，合并结果不变，只多花一点点传输量。
 * 选两个心跳而非一个：只挡够「L < 5000」这一条边界风险太薄，采集器一次
 * 轻微卡顿就会顶到临界值；两个心跳留出的余量足以覆盖偶发的单次心跳延迟。
 */
export const SAFETY_MS = 10_000;

/** 下一次请求的 since 水位：全部 series 里最大的 ts 减去安全边距；
 *  一个点都没有返回 null（不能变成负数的「全局最大 ts」） */
export function nextSince(payload: WindowPayload | null): number | null {
  if (payload === null) return null;
  let max: number | null = null;
  for (const points of Object.values(payload.series)) {
    for (const point of points) {
      if (max === null || point.ts > max) max = point.ts;
    }
  }
  return max === null ? null : max - SAFETY_MS;
}

/**
 * 拼窗口查询 URL：「水位为 null 时不带 since 参数」是增量协议本身的约定，
 * 不是某个消费者的实现细节，只应该有一处实现——散在多处调用点，早晚会有
 * 地方把 null 直接拼进模板字符串（"since=null"）。这类错误不会报错：
 * 服务端 `Number("null")` 是 NaN，会被 planWindowQuery 的否决①当成非法
 * since 挡下，静默退化为全量，是最难被发现的那类 bug。
 */
export function windowUrl(range: RangeKey, held: WindowPayload | null): string {
  const since = nextSince(held);
  return since !== null
    ? `/api/v1/metrics/window?range=${range}&since=${since}`
    : `/api/v1/metrics/window?range=${range}`;
}
