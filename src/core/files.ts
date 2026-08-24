/**
 * GGUF 文件名解析纯函数（M1 Task 3，无 IO）
 *
 * 覆盖的量化命名形态（llama.cpp 量化格式 + HF 常见发布名）：
 *
 * | 形态              | 正则分支                   | 例                    |
 * |-------------------|----------------------------|-----------------------|
 * | i-量化            | IQ\d+_?[A-Z0-9]*           | IQ4_XS / IQ2_XXS      |
 * | K 量化            | Q\d+_K(?:_[SML])?          | Q4_K_M / Q4_K_S / Q6_K |
 * | 旧式数字后缀      | Q\d_\d+                    | Q4_0 / Q5_1 / Q8_0    |
 * | 浮点              | BF16 / F16                 | BF16 / F16            |
 *
 * 边界规则（防乱串误报）：量化串必须是"贴着边界"的独立 token——
 * - 左边界：串首，或紧邻前一字符为非字母数字（- _ . 等，含 7B- 这类
 *   数字后缀结尾的连字符）
 * - 右边界：串尾，或紧邻后一字符为非字母数字（.gguf / - / _ 等）
 * 反例：notquantGGUFQ4K_Mx 中 "Q4K_M" 左邻是字母 F、GPTQ4 中 "Q4" 左邻
 * 是字母 T，均不命中 → null。
 *
 * 其他约定：
 * - 大小写不敏感匹配、统一大写返回（q8_0 → Q8_0）
 * - 最左命中优先（正常命名最多一个量化 token）
 * - 刻意不识别裸 Q<数字>（如 "Q4"）：非真实格式，且是把 Q4_K_Mx 这类
 *   残串截断成 "Q4" 的回溯假阳性来源；TQ1_0 / TQ2_0（tri-matrix）暂不识别
 */

/**
 * 量化 token 匹配：分组 1 消费左边界（捕获组写法而非 lookbehind，兼容性更好），
 * 分组 2 是量化本体；右边界用否定前瞻（后一个字符不是字母数字）。
 */
const QUANT_RE =
  /(^|[^A-Za-z0-9])(IQ\d+_?[A-Z0-9]*|Q\d+_K(?:_[SML])?|Q\d_\d+|BF16|F16)(?![A-Za-z0-9])/i;

/** 从文件名提取量化标签（大写归一）；无量化标识返回 null */
export function detectQuant(filename: string): string | null {
  const m = QUANT_RE.exec(filename);
  return m === null ? null : m[2].toUpperCase();
}

/**
 * 分片命名后缀：-<序号>-of-<总数>，锚定 .gguf 结尾（1-based；llama.cpp
 * 拆分约定为 5 位零填充，此处按 \d+ 宽容解析）。
 * 总数之后允许量化后缀（分隔符 . - _ 接字母数字，可多段，如
 * …-00002-of-00005.Q8_0.gguf / …-00001-of-00003.Q4_K_M.gguf），
 * 再以 .gguf 结尾；量化串也可出现在分片段之前（含在前缀里，不影响锚定）。
 */
const SHARD_RE = /-(\d+)-of-(\d+)(?:[.\-_][A-Za-z0-9]+)*\.gguf$/;

/** 解析分片信息；非 .gguf 或非分片命名返回 null */
export function shardInfo(filename: string): { index: number; total: number } | null {
  const m = SHARD_RE.exec(filename);
  return m === null ? null : { index: Number(m[1]), total: Number(m[2]) };
}

/**
 * 分片组标识（前缀 + 总数）：同组分片共享去掉 `-<序号>-of-<总数>` 后缀后的
 * 前缀与相同 total（qwen-00001-of-00003.gguf 与 qwen-00002-of-00003.gguf 同组）。
 * 非 .gguf 或非分片命名返回 null。
 * （M1 Task 10 新增导出：filesApi.siblingShards 按 prefix+total 匹配同组分片；
 * 不改 shardInfo 既有签名）
 */
export function shardGroup(filename: string): { prefix: string; total: number } | null {
  const m = SHARD_RE.exec(filename);
  if (m === null) return null;
  return { prefix: filename.slice(0, m.index), total: Number(m[2]) };
}
