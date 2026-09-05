/**
 * 多卡切分参数的校验提示与表单可见性判定（多卡支持批次，设计 §5）
 *
 * 形态沿用 core/gguf-hints.ts 的 { field, level, code, values }，i18n 按 code 渲染。
 *
 * **全部是 warn，一条都不硬拦。** 两条理由互相印证：
 * 1. gguf-hints.ts 的既有原则——「面板不代用户做决定，只提醒」；
 * 2. 单卡实测：`-sm tensor --cache-type-k q8_0 --cache-type-v q8_0` **照常启动**。
 *    tensor 在单卡下退化成单设备、不走多卡 KV 路径，官方文档所述的那组约束
 *    根本不触发。硬拦会误伤单卡用户本来能跑的配置，而面板在编辑时并不总能
 *    知道运行时会有几张卡。
 *
 * 规则照官方文档写、单卡机上可完整单测，但「这条校验是不是拦对了」只能到多卡机
 * 上证实（见 milestones/23 的 M2）。本文件不声称已验证多卡拦截效果。
 */

export type SplitHintCode =
  | "tensorKvQuant"
  | "tensorFlashAttnOff"
  | "rowDeprecated"
  | "mainGpuOutOfRange"
  | "tensorSplitCountMismatch";

export interface SplitHint {
  field: "split_mode" | "tensor_split" | "main_gpu";
  level: "warn";
  code: SplitHintCode;
  values?: Record<string, string | number>;
}

/** tensor 并行下 KV 缓存必须是非量化类型（取值域见 core/schemas.ts 的 cacheTypeSchema） */
const TENSOR_SAFE_CACHE: ReadonlySet<string> = new Set(["f16", "f32", "bf16"]);

/**
 * `tensor_split` 字符串 → 比例数组；空串 / 空项 / 非数字一律 null。
 * null 代表「解析不出」而非「零项」——调用方据此跳过项数判定，
 * 让编辑中的半截输入（如 `3,`）不弹提示，交给 zod 在预览里报。
 */
export function parseTensorSplit(raw: string): number[] | null {
  const parts = raw.split(",");
  const values: number[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
    values.push(Number(trimmed));
  }
  return values.length > 0 ? values : null;
}

export interface SplitHintsInput {
  /** 生效值（default ⊕ overrides），未设置为 undefined */
  splitMode: string | undefined;
  tensorSplit: string | undefined;
  mainGpu: number | undefined;
  /** 生效的 KV 缓存类型与 flash-attn 开关 */
  cacheK: string;
  cacheV: string;
  flashAttention: string;
  /**
   * 该模型可见的卡数（visibleDevices(...).length）。
   * GPU 探测不可用 / 纯 CPU 部署时为 null —— 此时跳过所有与卡数有关的判定：
   * 没有卡数就没有「越界」这个概念，凭空报警是噪音。
   */
  visibleCount: number | null;
}

export function splitHints(input: SplitHintsInput): SplitHint[] {
  const hints: SplitHint[] = [];

  if (input.splitMode === "tensor") {
    if (!TENSOR_SAFE_CACHE.has(input.cacheK) || !TENSOR_SAFE_CACHE.has(input.cacheV)) {
      hints.push({
        field: "split_mode",
        level: "warn",
        code: "tensorKvQuant",
        values: { cacheK: input.cacheK, cacheV: input.cacheV },
      });
    }
    if (input.flashAttention === "off") {
      hints.push({ field: "split_mode", level: "warn", code: "tensorFlashAttnOff" });
    }
  }

  if (input.splitMode === "row") {
    hints.push({ field: "split_mode", level: "warn", code: "rowDeprecated" });
  }

  const count = input.visibleCount;
  if (count !== null) {
    if (input.mainGpu !== undefined && input.mainGpu >= count) {
      hints.push({
        field: "main_gpu",
        level: "warn",
        code: "mainGpuOutOfRange",
        values: { actual: input.mainGpu, count },
      });
    }
    if (input.tensorSplit !== undefined) {
      const ratios = parseTensorSplit(input.tensorSplit);
      if (ratios !== null && ratios.length !== count) {
        hints.push({
          field: "tensor_split",
          level: "warn",
          code: "tensorSplitCountMismatch",
          values: { actual: ratios.length, count },
        });
      }
    }
  }

  return hints;
}

/**
 * 切分参数区是否展示。用的是**整机卡数**而非该模型可见卡数——用户可能整机两张卡
 * 但只给这个模型一张，此时仍需看到控件才能改。
 *
 * 已有覆盖值时无条件展示：否则从别处导入 / YAML 带进来的配置会看不见也改不掉。
 */
export function shouldShowSplitFields(input: {
  deviceCount: number;
  hasOverride: boolean;
}): boolean {
  return input.deviceCount > 1 || input.hasOverride;
}
