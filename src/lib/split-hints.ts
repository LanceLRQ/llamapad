/**
 * 多卡切分参数的校验提示与表单可见性判定（多卡支持批次，设计 §5）
 *
 * 形态沿用 core/gguf-hints.ts 的 { field, level, code, values }，i18n 按 code 渲染。
 *
 * **全部是 warn，一条都不硬拦。** 这个决策在 2026-09-05 的双 V100 真机验证中被证明是对的：
 * 官方文档所述的「tensor 要求 KV 不量化」实测**不成立**——`-sm tensor --cache-type-k q8_0
 * --cache-type-v q8_0` 在双卡下照常启动，两卡各 19493 MiB 对称分配。若当初按文档做成硬拦，
 * 这台机器上本来能跑的配置会被面板拦死。另一条理由是 gguf-hints.ts 的既有原则——
 * 「面板不代用户做决定，只提醒」。
 *
 * 五条规则的真机结论（双 V100 + Qwen3.8-27B-Q8_0，详见 audit/AUDIT-2026-09-05-多卡真机验证.md）：
 * - tensorFlashAttnOff ✅ 属实：`-sm tensor -fa off` 创建上下文失败，模型起不来
 * - rowDeprecated ✅ 属实且证据更强：V100 双卡与 RTX 3090 单卡报的是同一条
 *   `does not support split buffers`，说明不是单卡退化所致
 * - tensorKvQuant ⚠️ 假设被推翻：多卡下不拒绝，文案已改为「建议」而非「可能拒绝启动」
 * - mainGpuOutOfRange / tensorSplitCountMismatch ✅ 表单实测提示正确，且越界判定
 *   用的是该模型可见卡数（2）而非整机卡数（4）。`main_gpu` 语义改为宿主机编号后
 *   （翻译落点见 core/args.ts 的 toContainerGpuIndex），mainGpuOutOfRange 的判定
 *   依据也从「数值小于可见卡数」改成「数值属于可见卡号集合」——宿主机编号不保证
 *   连续（如 device=2,3），前者会把 main_gpu=3 这种完全合法的配置误判成越界
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
   * 该模型可见的卡号数组（宿主机编号，visibleDevices(...).map(d => d.index)）。
   * GPU 探测不可用 / 纯 CPU 部署时为 null —— 此时跳过所有与卡数/卡号有关的判定：
   * 没有卡号列表就没有「越界」这个概念，凭空报警是噪音。
   *
   * `main_gpu` 语义变更为宿主机编号后（见 core/args.ts），越界判定不能再用
   * 「数值 < 卡数」——宿主机编号不保证从 0 连续（如 device=2,3），必须直接判断
   * 数值是否属于这个数组。
   */
  visibleIndexes: number[] | null;
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

  const indexes = input.visibleIndexes;
  if (indexes !== null) {
    if (input.mainGpu !== undefined && !indexes.includes(input.mainGpu)) {
      hints.push({
        field: "main_gpu",
        level: "warn",
        code: "mainGpuOutOfRange",
        // 中性的逗号+空格而非中文顿号：这个值同时喂给 zh/en 两份文案
        // （i18n/messages/{zh,en}.json 的 splitHints.mainGpuOutOfRange），
        // 顿号在英文文案里不可读
        values: { actual: input.mainGpu, allowed: indexes.join(", ") },
      });
    }
    if (input.tensorSplit !== undefined) {
      const ratios = parseTensorSplit(input.tensorSplit);
      if (ratios !== null && ratios.length !== indexes.length) {
        hints.push({
          field: "tensor_split",
          level: "warn",
          code: "tensorSplitCountMismatch",
          values: { actual: ratios.length, count: indexes.length },
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
