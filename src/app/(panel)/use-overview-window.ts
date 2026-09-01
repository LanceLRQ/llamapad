"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { apiFetch } from "@/lib/api";
import { mergeWindowPayload, windowUrl } from "@/lib/metrics-window-merge";
import { useRefreshInterval } from "@/lib/use-refresh-interval";
import { type RangeKey, type WindowPayload } from "@/server/metrics/window";

/**
 * 概览合卡「图表历史」轮询 hook（任务 13 从 overview-charts.tsx 拆出；
 * 任务 11 步骤 3 补 SSR 首帧播种）：range Tabs 状态、window API 增量轮询、
 * 切档竞态处理全收在这里，主组件只消费 { range, setRange, data, failed }。
 *
 * SSR 首帧播种：initialPayload 由 (panel)/page.tsx 服务端直调
 * getMetricsStore().queryRange() + buildWindowPayload() 传入（30m 档，
 * 不经 HTTP，与 initialGpuStatus 的既有做法同款）。loaded 的初值直接是
 * 这份数据而不是 null——客户端首次 load() 时 loadedRef 已非空，windowUrl
 * 据此算出 since 发一条增量请求而不是全量，面板重启后第一眼就有重启前的
 * 历史（分钟级台阶），不再空等一个 RTT 才出图。
 */
export interface OverviewWindow {
  range: RangeKey;
  setRange: (range: RangeKey) => void;
  data: WindowPayload | null;
  failed: boolean;
}

export function useOverviewWindow(initialPayload: WindowPayload): OverviewWindow {
  const { intervalMs } = useRefreshInterval();
  const [range, setRange] = useState<RangeKey>(initialPayload.range);
  const [loaded, setLoaded] = useState<{ range: RangeKey; payload: WindowPayload } | null>({
    range: initialPayload.range,
    payload: initialPayload,
  });
  /** loaded 的镜像，供 load 内部读取：load 依赖数组必须保持 [range]（下方
   *  useEffect 用它建 setInterval），若直接读 loaded state 就得把 loaded
   *  加进依赖数组——而 loaded 每个 tick 都在变，会导致 effect 每 tick 重建
   *  定时器、打乱轮询节拍。用 ref 绕开这层依赖 */
  const loadedRef = useRef<{ range: RangeKey; payload: WindowPayload } | null>(loaded);
  const [failed, setFailed] = useState(false);
  const data = loaded !== null && loaded.range === range ? loaded.payload : null;

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        // ref 里的数据若属于另一档 range（刚切档），视为没有历史：既不能
        // 拿旧档的点去合并新档响应，也不能带着旧档的 ts 当 since 去查询
        const prevPayload = loadedRef.current?.range === range ? loadedRef.current.payload : null;
        const res = await apiFetch(windowUrl(range, prevPayload), { signal, cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const incoming = (await res.json()) as WindowPayload;
        if (signal?.aborted) return; // 切窗竞态：迟到响应丢弃
        const next = { range, payload: mergeWindowPayload(prevPayload, incoming) };
        loadedRef.current = next;
        setLoaded(next);
        setFailed(false);
      } catch (error) {
        // 请求失败不做任何特殊处理：since 水位不前进，下一轮 delta 自然
        // 覆盖这段空档，不会产生数据洞；连续失败超过 ring 容量（2h）后
        // since 早于新的 from，服务端否决③会自动退回全量，是自愈的
        if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
          return;
        }
        setFailed(true);
      }
    },
    [range],
  );

  // 数据获取与自动刷新（range 变化即重建）：节奏上 30m/2h 跟随用户选中的
  // intervalMs、24h/7d 恒 60s（背后是分钟级/15 分钟级聚合桶，秒级轮询没有
  // 意义）；不可见跳过，回到可见立即补拉。
  useEffect(() => {
    const controller = new AbortController();
    const pollMs = range === "30m" || range === "2h" ? intervalMs : 60_000;
    const tick = () => {
      if (!document.hidden) void load(controller.signal);
    };
    const timer = setInterval(tick, pollMs);
    tick(); // 初次加载（30m 档首帧已有 SSR 数据，这次实际发出的是一条增量请求）
    const onVisibility = () => {
      if (!document.hidden) tick();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      controller.abort();
    };
  }, [load, range, intervalMs]);

  return { range, setRange, data, failed };
}
