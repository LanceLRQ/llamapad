import type { UpstreamHealthState } from "./upstream-health";

/**
 * 外部上游对外的视图（接口响应与页面组件共用）。不含密钥明文。
 */
export interface UpstreamView {
  name: string;
  displayName: string;
  baseUrl: string;
  hasApiKey: boolean;
  /** 密钥尾 4 位；没有密钥为 null */
  apiKeyTail: string | null;
  upstreamModel: string | null;
  enabled: boolean;
  note: string | null;
  /** 存活状态；已停用的上游不探测，固定为 disabled */
  state: UpstreamHealthState | "disabled";
  /** 最近一次得出结论的时间（ISO）；没有为 null */
  lastCheckedAt: string | null;
  lastError: string | null;
  /** 是否是用户设置的默认上游（不论当前是否因不可达而降级） */
  isDefault: boolean;
  /** 别名，按登记顺序；没有为空数组 */
  aliases: { alias: string; upstreamModel: string | null }[];
  createdAt: string;
  updatedAt: string;
}

/** 「测试连接」的结果（与 server/upstreams/monitor.ts 的 ProbeResult 同形） */
export interface UpstreamProbeView {
  ok: boolean;
  status: number | null;
  latencyMs: number;
  models: string[];
  error: string | null;
}
