import { describe, expect, it } from "vitest";

import { fieldAliases } from "./readme-params";
import { verifyValue } from "./readme-verify";

const R1 = "Set the temperature within the range of 0.5-0.7 (0.6 is recommended) to prevent endless repetitions.";

describe("verifyValue 数值通道", () => {
  it("原样出现即命中，并带回命中所在的整句", () => {
    const hit = verifyValue(0.6, R1, []);
    expect(hit).not.toBeNull();
    expect(hit!.sentence).toContain("0.6 is recommended");
  });

  it("小数尾零等值命中：README 写 0.60，AI 给 0.6", () => {
    expect(verifyValue(0.6, "use temp 0.60 for best results", [])).not.toBeNull();
  });

  it("千分位逗号等值命中：README 写 32,768，AI 给 32768", () => {
    expect(verifyValue(32768, "context length is 32,768 tokens", [])).not.toBeNull();
  });

  it("整数与浮点写法等值命中：README 写 1.0，AI 给 1", () => {
    expect(verifyValue(1, "repeat_penalty 1.0", [])).not.toBeNull();
  });

  // 这条是数值通道存在的全部理由：字符串 includes 会把 "0.6" 在 "10.65" 里认成命中
  it("不做子串匹配：0.6 不命中 10.65", () => {
    expect(verifyValue(0.6, "the value is 10.65 here", [])).toBeNull();
  });

  it("范围值不算命中：原文只写了 0.5-0.7 时 0.6 不命中", () => {
    expect(verifyValue(0.6, "temperature in the range 0.5-0.7", [])).toBeNull();
  });

  it("不做单位换算：32768 不命中 32k", () => {
    expect(verifyValue(32768, "context 32k tokens", [])).toBeNull();
  });

  it("负数命中", () => {
    expect(verifyValue(-1, "set dry_penalty_last_n to -1", [])).not.toBeNull();
  });

  // 以下六条是修复轮补的回归：整篇 README 上必然出现的形状，曾把闸门骗过去
  it("日期里的连字符不是负号：-1 不命中 2024-01-15", () => {
    expect(verifyValue(-1, "Released on 2024-01-15, this model achieves top scores.", [])).toBeNull();
  });

  it("型号名里的连字符不是负号：-8 不命中 Llama-3.1-8B", () => {
    expect(verifyValue(-8, "See Llama-3.1-8B-Instruct for details.", [])).toBeNull();
  });

  it("数字只是更长标识的一截时不命中", () => {
    expect(verifyValue(8, "the 8B variant", [])).toBeNull();
    expect(verifyValue(4, "quantized to Q4_K_M", [])).toBeNull();
  });

  it("版本号不算参数值", () => {
    expect(verifyValue(1, "built on v1.5 of the base", [])).toBeNull();
    expect(verifyValue(1, "toolkit 1.0.5 required", [])).toBeNull();
  });

  it("句末句点不影响命中", () => {
    expect(verifyValue(0.6, "Set the temperature to 0.6.", [])).not.toBeNull();
  });

  it("紧贴等号仍命中", () => {
    expect(verifyValue(0.6, "--temp=0.6", [])).not.toBeNull();
    expect(verifyValue(-1, "set dry_penalty_last_n=-1", [])).not.toBeNull();
  });
});

describe("verifyValue 字符串与布尔通道", () => {
  it("字符串归一化后原样命中", () => {
    expect(verifyValue("q8_0", "--cache-type-k q8_0 --cache-type-v q8_0", [])).not.toBeNull();
  });

  it("大小写不敏感", () => {
    expect(verifyValue("Q8_0", "use q8_0 for the kv cache", [])).not.toBeNull();
  });

  it("布尔按字面量命中", () => {
    expect(verifyValue(true, "set enable_thinking: true", [])).not.toBeNull();
    expect(verifyValue(false, "set enable_thinking: true", [])).toBeNull();
  });

  it("原文里没有就是没有", () => {
    expect(verifyValue("q4_0", "--cache-type-k q8_0", [])).toBeNull();
  });

  // 以下四条是最终审查实测的误命中：一篇零参数推荐的 README 曾让三个枚举字段
  // 全部骗过闸门。走这条通道的值都是 2-4 字符枚举，不加词边界等于没有闸门
  const NOISE = "This repo provides BF16 and Q4_K_M quants. Offloading to GPU is recommended. Follow the instructions below to run llama-server.";

  it("枚举值不命中单词内部：on 不命中 instructions", () => {
    expect(verifyValue("on", NOISE, [])).toBeNull();
  });

  it("off 不命中 Offloading（词首相同但后面还连着字母）", () => {
    expect(verifyValue("off", NOISE, [])).toBeNull();
  });

  it("f16 不命中 BF16", () => {
    expect(verifyValue("f16", NOISE, [])).toBeNull();
  });

  it("low 不命中 Follow / below", () => {
    expect(verifyValue("low", NOISE, [])).toBeNull();
  });

  it("独立出现时仍然命中，且跳过前面的词内误命中", () => {
    // "Offloading" 在前、真正的 --flash-attn off 在后：前者被边界拒掉，后者命中
    expect(verifyValue("off", "Offloading is fine. Use --flash-attn off here.", [])).not.toBeNull();
  });

  it("紧贴标点仍命中", () => {
    expect(verifyValue("q8_0", "set cache type to q8_0.", [])).not.toBeNull();
  });
});

describe("命中句定位", () => {
  it("按句末标点切句，不把整段带出来", () => {
    const body = "First sentence here. Set temperature to 0.6 now. Third sentence.";
    const hit = verifyValue(0.6, body, []);
    expect(hit!.sentence).toBe("Set temperature to 0.6 now.");
  });

  it("中文句号同样切句", () => {
    const body = "这是第一句。温度建议设为 0.6 效果最好。这是第三句。";
    expect(verifyValue(0.6, body, [])!.sentence).toBe("温度建议设为 0.6 效果最好。");
  });

  it("换行也是句边界", () => {
    const body = "line one\ntemperature 0.6\nline three";
    expect(verifyValue(0.6, body, [])!.sentence).toBe("temperature 0.6");
  });

  it("超长句硬截到 200 字符（与既有 excerpt 同口径）", () => {
    const body = `${"x".repeat(400)} 0.6 ${"y".repeat(400)}`;
    const hit = verifyValue(0.6, body, []);
    expect(hit!.sentence.length).toBeLessThanOrEqual(200);
    expect(hit!.sentence).toContain("0.6");
  });

  it("英文句点后面跟着数字时不算句末：v1.5 不切句", () => {
    const hit = verifyValue(0.6, "Model v1.5 wants temperature 0.6 today.", []);
    expect(hit!.sentence).toBe("Model v1.5 wants temperature 0.6 today.");
  });
});

describe("边界", () => {
  it("空原文一律不命中", () => {
    expect(verifyValue(0.6, "", [])).toBeNull();
  });

  it("null / undefined 值不命中，且不抛错", () => {
    expect(verifyValue(null, R1, [])).toBeNull();
    expect(verifyValue(undefined, R1, [])).toBeNull();
  });

  it("NaN 不命中", () => {
    expect(verifyValue(Number.NaN, "0.6", [])).toBeNull();
  });
});

describe("强弱分级命中", () => {
  // 真机实测那篇 README 的形状：全文靠前处有个无关的孤立 1（层数说明里的
  // "1 × (Gated Attention"），靠后才是作者真正写参数的那一句。改造前取第一个
  // 匹配，于是把层数说明当成了 temp=1 的出处
  const REAL = [
    "- Hidden Layout: 8 × (3 × (Gated DeltaNet → FFN) → 1 × (Gated Attention → FFN))",
    "> - Thinking mode for general tasks: `temperature=1.0, top_p=0.95, min_p=0.0`",
  ].join("\n");

  it("优先取含参数名的那一句，而不是第一个匹配", () => {
    const hit = verifyValue(1, REAL, fieldAliases("temp"));
    expect(hit).not.toBeNull();
    expect(hit!.strength).toBe("strong");
    expect(hit!.sentence).toContain("temperature=1.0");
    expect(hit!.sentence).not.toContain("Gated Attention");
  });

  it("只有孤立数值时降为弱命中，但不丢弃", () => {
    const hit = verifyValue(0, '<p style="margin-bottom: 0;">', fieldAliases("min_p"));
    expect(hit).not.toBeNull();
    expect(hit!.strength).toBe("weak");
  });

  it("一个候选都没有仍然返回 null", () => {
    expect(verifyValue(0.37, REAL, fieldAliases("temp"))).toBeNull();
  });

  it("别名大小写不敏感", () => {
    const hit = verifyValue(1, "Temperature=1.0 is recommended", fieldAliases("temp"));
    expect(hit!.strength).toBe("strong");
  });

  it("连字符写法也算参数名在场", () => {
    const hit = verifyValue(0.95, "set top-p 0.95 for best results", fieldAliases("top_p"));
    expect(hit!.strength).toBe("strong");
  });

  it("字符串通道同样分级", () => {
    const strong = verifyValue("q8_0", "--cache-type-k q8_0", fieldAliases("cache_type_k"));
    expect(strong!.strength).toBe("strong");
    const weak = verifyValue("q8_0", "见 quant 说明：q8_0 与 q4_0 的区别", fieldAliases("cache_type_k"));
    expect(weak!.strength).toBe("weak");
  });

  it("别名表为空时一律是弱命中——分级需要参数名，没有就判不出强", () => {
    expect(verifyValue(0.6, "temperature 0.6", [])!.strength).toBe("weak");
  });
});
