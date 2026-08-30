/**
 * 面板配置 ↔ llama-server 实际生效值的比对（自建 Playground 的参数栏）
 *
 * 面板把采样参数作为**启动参数**传给 llama-server（core/args.ts），
 * `/props.default_generation_settings.params` 是服务端回读的**实际生效值**。
 * 两者不一致 = 容器不是用当前配置起的（改了配置没重启，或手工起的容器）。
 * 这是 Playground 相对"打开 llama UI"的核心差异化：它能证明参数真的生效了。
 *
 * 两个坑：
 * 1. **键名不同名**：配置叫 temp，/props 叫 temperature（其余同名）。
 * 2. **float32 回读**：配置 0.8 从 /props 读回来是 0.800000011920929。
 *    直接 === 比较会让每个浮点参数都误报漂移，必须带相对容差。
 */
import type { ServerConfig } from "@/core/schemas";

/** 参与比对的采样参数：配置字段名 → /props 键名（实测键名，勿改） */
export const SAMPLING_ROWS: ReadonlyArray<{ key: SamplingKey; propsKey: string }> = [
  { key: "temp", propsKey: "temperature" },
  { key: "top_k", propsKey: "top_k" },
  { key: "top_p", propsKey: "top_p" },
  { key: "min_p", propsKey: "min_p" },
  { key: "repeat_penalty", propsKey: "repeat_penalty" },
  { key: "presence_penalty", propsKey: "presence_penalty" },
];

export type SamplingKey =
  | "temp"
  | "top_k"
  | "top_p"
  | "min_p"
  | "repeat_penalty"
  | "presence_penalty";

export type SamplingConfig = Pick<ServerConfig, SamplingKey>;

/** 从完整 ServerConfig 投影出参数栏需要的 6 个采样键（page.tsx 用它构造传给
 *  client 组件的 config，避免把整个 ServerConfig 原样序列化进 RSC payload——
 *  类型标注是 SamplingConfig，运行时形状不该比类型宽）。复用 SAMPLING_ROWS
 *  这份键名权威清单，不再手抄一份 */
export function pickSamplingConfig(config: ServerConfig): SamplingConfig {
  return Object.fromEntries(
    SAMPLING_ROWS.map(({ key }) => [key, config[key]]),
  ) as SamplingConfig;
}

export interface DriftRow {
  key: SamplingKey;
  /** 面板配置值 */
  configured: number;
  /** 服务端实际值；/props 无此键或非数值时 null */
  actual: number | null;
  /** 两者实质不同（带 float32 容差）；actual 为 null 时恒 false */
  drift: boolean;
}

/** float32 往返容差：0.8 → 0.800000011920929，相对误差约 1.5e-8，取 1e-6 留足余量 */
const RELATIVE_TOLERANCE = 1e-6;

function sameNumber(a: number, b: number): boolean {
  return Math.abs(a - b) <= RELATIVE_TOLERANCE * Math.max(1, Math.abs(a), Math.abs(b));
}

export function compareSampling(
  config: SamplingConfig,
  propsParams: Record<string, unknown>,
): DriftRow[] {
  return SAMPLING_ROWS.map(({ key, propsKey }) => {
    const configured = config[key];
    const raw = propsParams[propsKey];
    const actual = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
    return {
      key,
      configured,
      actual,
      drift: actual !== null && !sameNumber(configured, actual),
    };
  });
}
