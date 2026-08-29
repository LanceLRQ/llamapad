/**
 * PageHeader 纯逻辑层（M16 T2）：把"空态判定"从组件里搬出来，配 .test.ts
 * 覆盖（对齐 lib/status-bar.ts 的既有做法——vitest 是 environment: "node"，
 * 组件渲染测试跑不动，可测逻辑一律下沉到这里）。
 *
 * 核心判断：value === 0 与 value === null 走同一条空态渲染路径——"这个空间
 * 没有模型在跑"和"有 0 个"是同一件事，但阿拉伯数字 0 会被读成一个待办数量
 * （像未读消息角标），破折号才读作"空"。字符串形态的 "0"/""同理视为空态，
 * 不能因为调用方传的是字符串就走出两种表现。
 */

export interface StatDisplay {
  /** 主值文本，空态固定是 "—" */
  text: string;
  /** 值后缀单位；空态不带单位（"— GB" 没有意义） */
  unit: string | null;
  /** 调用方据此加弱化样式（整列降透明度） */
  empty: boolean;
}

export function formatStat(value: string | number | null, unit?: string): StatDisplay {
  const empty = value === null || value === 0 || value === "0" || value === "";
  if (empty) {
    return { text: "—", unit: null, empty: true };
  }
  return { text: String(value), unit: unit ?? null, empty: false };
}
