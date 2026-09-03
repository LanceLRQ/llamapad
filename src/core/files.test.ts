import { describe, expect, it } from "vitest";
import { detectQuant, shardInfo } from "./files";

/**
 * detectQuant / shardInfo 测试（M1 Task 3，纯函数无 IO）
 *
 * 行为锚定（真实生态命名样本，llama.cpp 量化格式 + HF 常见发布名）：
 * - 量化标签 = 文件名中"贴着边界"的独立 token：紧邻前一字符是串首或非字母
 *   数字（- _ . 等），紧邻后一字符是串尾或非字母数字（.gguf / - / _ 等）；
 *   命中后统一大写返回，未检出返回 null
 * - 分片命名 <前缀>-<序号>-of-<总数>.gguf（1-based），量化串可出现在
 *   分片段之后（…-00002-of-00005.Q8_0.gguf）
 */

describe("detectQuant：K 量化 / IQ / 旧式数字后缀 / 浮点（真实命名）", () => {
  it("K 量化：Q<位宽>_K[_SML]（Q4_K_M / Q4_K_S / Q6_K / Q2_K）", () => {
    expect(detectQuant("Qwen3-32B-Q4_K_M.gguf")).toBe("Q4_K_M");
    expect(detectQuant("Qwen3-VL-8B-Q4_K_S.gguf")).toBe("Q4_K_S");
    expect(detectQuant("gemma-3-27b-it-Q6_K.gguf")).toBe("Q6_K");
    expect(detectQuant("llama-3.1-8B-Q2_K.gguf")).toBe("Q2_K");
  });

  it("IQ 系列：IQ<位宽>_<后缀>（IQ4_XS / IQ2_XXS）", () => {
    expect(detectQuant("DeepSeek-R1-IQ4_XS.gguf")).toBe("IQ4_XS");
  });

  // 真机 unsloth/Qwen3.8-27B-GGUF：UD 系列用两字母后缀。改前 `[SML]` 吃不下
  // `_XL`，但 `Q4_K` 会先匹配成功（其后的 `_` 不是字母数字，否定前瞻放行），
  // 于是静默截断——`UD-Q6_K_XL` 被截成 `Q6_K`，与同仓库真的 `UD-Q6_K` 撞标签
  it("K 量化的两字母后缀（unsloth UD 系列）", () => {
    expect(detectQuant("Qwen3.8-27B-UD-Q4_K_XL.gguf")).toBe("Q4_K_XL");
    expect(detectQuant("Qwen3.8-27B-UD-Q2_K_XL.gguf")).toBe("Q2_K_XL");
    expect(detectQuant("Qwen3.8-27B-UD-Q5_K_XL.gguf")).toBe("Q5_K_XL");
  });

  it("XL 后缀不再与同仓库的无后缀档撞标签", () => {
    expect(detectQuant("Qwen3.8-27B-UD-Q6_K_XL.gguf")).toBe("Q6_K_XL");
    expect(detectQuant("Qwen3.8-27B-UD-Q6_K.gguf")).toBe("Q6_K");
    expect(detectQuant("Qwen3.8-27B-UD-Q6_K_L.gguf")).toBe("Q6_K_L");
  });

  // 后缀枚举而非 [A-Z]+：非量化后缀不该被吞进标签（标签会被当分组键用）
  it("不把任意大写后缀当成量化后缀", () => {
    expect(detectQuant("model-Q4_K_MERGED.gguf")).toBe("Q4_K");
    expect(detectQuant("DeepSeek-R1-0528-IQ2_XXS.gguf")).toBe("IQ2_XXS");
  });

  it("旧式数字后缀：Q<位宽>_<数字>（Q8_0 / Q4_0），小写输入归一为大写", () => {
    expect(detectQuant("qwen-2.5-7b-q8_0.gguf")).toBe("Q8_0");
    expect(detectQuant("model-00003-of-00005.Q4_0.gguf")).toBe("Q4_0");
  });

  it("浮点格式：F16 / BF16（含 mmproj 投影文件）", () => {
    expect(detectQuant("model-F16.gguf")).toBe("F16");
    expect(detectQuant("mmproj-F16.gguf")).toBe("F16");
    expect(detectQuant("glm-4.5-air-BF16.gguf")).toBe("BF16");
  });
});

describe("detectQuant：边界规则", () => {
  it("量化串前是串首 / - / _ / . 均命中（贴界 token）", () => {
    expect(detectQuant("Q4_K_M.gguf")).toBe("Q4_K_M"); // 串首
    expect(detectQuant("qwen3_Q6_K.gguf")).toBe("Q6_K"); // 前面是 _
    expect(detectQuant("model-00003-of-00005.Q4_0.gguf")).toBe("Q4_0"); // 前面是 .（分片命名）
  });

  it("无量化标识返回 null", () => {
    expect(detectQuant("plain-model.gguf")).toBeNull();
  });

  it("夹在字母数字中间的乱串不误报（不贴界）", () => {
    // "Q4K_M" 前面是字母 F（GGUF 的 F），不是独立 token
    expect(detectQuant("notquantGGUFQ4K_Mx.gguf")).toBeNull();
    // "Q4" 前面是字母 T，同上
    expect(detectQuant("GPTQ4.gguf")).toBeNull();
  });
});

describe("shardInfo：分片命名解析", () => {
  it("x-00001-of-00003.gguf → { index: 1, total: 3 }（1-based）", () => {
    expect(shardInfo("x-00001-of-00003.gguf")).toEqual({ index: 1, total: 3 });
  });

  it("量化串在分片段之后仍可解析（model-00002-of-00005.Q8_0.gguf）", () => {
    expect(shardInfo("model-00002-of-00005.Q8_0.gguf")).toEqual({ index: 2, total: 5 });
  });

  it("非分片命名或非 .gguf 扩展名返回 null", () => {
    expect(shardInfo("a.gguf")).toBeNull();
    expect(shardInfo("x-00001-of-00002.txt")).toBeNull();
  });
});
