import { describe, expect, it } from "vitest";
import type { ModelConfig } from "@/core/schemas";
import {
  buildDuplicatePayload,
  deriveOverrides,
  initDrafts,
  initDuplicateDrafts,
  mergeForSave,
  toFloatOrNull,
  toIntOrNull,
} from "./model-form";

/**
 * 表单三态转换（草稿字符串 ↔ overrides）。
 * 重点全在「空串 / 零值 / false 三者不能塌成同一态」上——
 * gpu_layers=0（保守预设）与 enable_thinking=false 都是有效覆盖，
 * 用 `if (v)` 写就会被吞掉，这两条是本文件最有价值的守卫。
 */

const BASE: ModelConfig = {
  name: "qwen3-8b",
  display_name: "Qwen3 8B",
  namespace: "main",
  gguf_file: "main/qwen3-8b-Q4_K_M.gguf",
  overrides: {},
};

/** 全空草稿（各用例按需覆盖单键） */
const EMPTY = initDrafts(BASE);

describe("toIntOrNull / toFloatOrNull", () => {
  it("整数：接受带空白的整数与负数，拒绝小数与非数字", () => {
    expect(toIntOrNull(" 12 ")).toBe(12);
    expect(toIntOrNull("-3")).toBe(-3);
    expect(toIntOrNull("0")).toBe(0);
    expect(toIntOrNull("1.5")).toBeNull();
    expect(toIntOrNull("abc")).toBeNull();
    expect(toIntOrNull("")).toBeNull();
  });

  it("浮点：空串与非有限值为 null，0 与负数是有效值", () => {
    expect(toFloatOrNull("0.7")).toBe(0.7);
    expect(toFloatOrNull("0")).toBe(0);
    expect(toFloatOrNull("-1")).toBe(-1);
    expect(toFloatOrNull("abc")).toBeNull();
    expect(toFloatOrNull("")).toBeNull();
  });
});

describe("initDrafts", () => {
  it("无 overrides：参数字段全为空串（= 跟随默认），身份字段取模型值", () => {
    expect(EMPTY.displayName).toBe("Qwen3 8B");
    expect(EMPTY.namespace).toBe("main");
    expect(EMPTY.ggufFile).toBe("main/qwen3-8b-Q4_K_M.gguf");
    expect(EMPTY.mmproj).toBe("");
    expect(EMPTY.gpuMode).toBe("default");
    expect(EMPTY.gpuLayers).toBe("");
    expect(EMPTY.thinking).toBe("");
    expect(EMPTY.effort).toBe("");
  });

  it("gpu=device=0,1 → gpuMode device + gpuDevices 去前缀", () => {
    const d = initDrafts({ ...BASE, overrides: { docker: { gpu: "device=0,1" } } });
    expect(d.gpuMode).toBe("device");
    expect(d.gpuDevices).toBe("0,1");
  });

  it("gpu=all / none → 同名 gpuMode，gpuDevices 留空", () => {
    expect(initDrafts({ ...BASE, overrides: { docker: { gpu: "all" } } }).gpuMode).toBe("all");
    expect(initDrafts({ ...BASE, overrides: { docker: { gpu: "none" } } }).gpuMode).toBe("none");
    expect(initDrafts({ ...BASE, overrides: { docker: { gpu: "none" } } }).gpuDevices).toBe("");
  });

  it("enable_thinking=false 与 gpu_layers=0 是有效覆盖，不能塌成空串", () => {
    const d = initDrafts({
      ...BASE,
      overrides: { server: { enable_thinking: false, gpu_layers: 0 } },
    });
    expect(d.thinking).toBe("false");
    expect(d.gpuLayers).toBe("0");
  });

  it("mmproj_file 缺省 → 空串", () => {
    expect(initDrafts({ ...BASE, mmproj_file: "main/mmproj-F16.gguf" }).mmproj).toBe(
      "main/mmproj-F16.gguf",
    );
    expect(EMPTY.mmproj).toBe("");
  });

  it("reasoning_effort=inherit 是有效覆盖 → effort 草稿原样带出，不塌成空串", () => {
    const d = initDrafts({ ...BASE, overrides: { server: { reasoning_effort: "inherit" } } });
    expect(d.effort).toBe("inherit");
  });
});

describe("initDuplicateDrafts", () => {
  it("只在显示名后缀化，其余字段与 initDrafts 逐字一致", () => {
    const model: ModelConfig = {
      ...BASE,
      mmproj_file: "main/mmproj-F16.gguf",
      overrides: { docker: { gpu: "all" }, server: { ctx_size: 65536 } },
    };
    const dup = initDuplicateDrafts(model, "（副本）");
    expect(dup.displayName).toBe("Qwen3 8B（副本）");
    expect({ ...dup, displayName: "" }).toEqual({ ...initDrafts(model), displayName: "" });
  });
});

describe("deriveOverrides", () => {
  it("全空草稿 → 空 overrides（两个 section 都不出现）", () => {
    expect(deriveOverrides(EMPTY)).toEqual({});
  });

  it("thinking=\"false\" 落成布尔 false，而非被跳过", () => {
    expect(deriveOverrides({ ...EMPTY, thinking: "false" })).toEqual({
      server: { enable_thinking: false },
    });
  });

  it("gpuLayers=\"0\" 落成数字 0，而非被跳过", () => {
    expect(deriveOverrides({ ...EMPTY, gpuLayers: "0" })).toEqual({ server: { gpu_layers: 0 } });
  });

  it("gpuMode=device 拼回 device=<设备串>，两侧空白剔除", () => {
    expect(deriveOverrides({ ...EMPTY, gpuMode: "device", gpuDevices: " 0,1 " })).toEqual({
      docker: { gpu: "device=0,1" },
    });
  });

  it("gpuMode=default 不产出 docker.gpu", () => {
    expect(deriveOverrides({ ...EMPTY, gpuMode: "default", gpuDevices: "0" })).toEqual({});
  });

  it("非法数字中间态如实丢弃（交给预览层报错，不阻塞输入）", () => {
    expect(deriveOverrides({ ...EMPTY, hostPort: "80a" })).toEqual({});
  });

  it('effort="inherit" 落成有效覆盖，与 thinking="false"/gpuLayers="0" 同属"不能塌成空串"的约定', () => {
    expect(deriveOverrides({ ...EMPTY, effort: "inherit" })).toEqual({
      server: { reasoning_effort: "inherit" },
    });
  });

  it("effort 空串不写入 overrides（未覆盖，跟随全局默认配置）", () => {
    expect(deriveOverrides({ ...EMPTY, effort: "" })).toEqual({});
  });
});

describe("mergeForSave", () => {
  it("表单外的既有覆盖原样保留", () => {
    const original = { docker: { model_volume: "/srv:/models" } } as never;
    expect(mergeForSave(original, {})).toEqual({ docker: { model_volume: "/srv:/models" } });
  });

  it("可编辑键在草稿里清空 → 从结果中删除", () => {
    const original = { server: { ctx_size: 8192 } } as never;
    expect(mergeForSave(original, {})).toEqual({});
  });

  it("可编辑键有新值 → 覆盖旧值，同 section 的非可编辑键不受影响", () => {
    const original = { server: { ctx_size: 8192, batch_size: 512 } } as never;
    expect(mergeForSave(original, { server: { ctx_size: 65536 } })).toEqual({
      server: { ctx_size: 65536, batch_size: 512 },
    });
  });

  it("清空后 section 为空 → 整个 section 不出现在结果里", () => {
    const original = { docker: { host_port: 9000 }, server: { ctx_size: 8192 } } as never;
    expect(mergeForSave(original, {})).toEqual({});
  });
});

/**
 * 克隆提交体装配（规格 §5、§7）：本分支唯一没有测试守卫的新增数据路径，
 * 补测重点是 download 透传与缺省——丢了不会报错，只有文件被误删、用户
 * 想重下时才会在真机上发现新模板没有来源信息。
 */
describe("buildDuplicatePayload", () => {
  it("源模型有 download → 整份透传", () => {
    const source: ModelConfig = {
      ...BASE,
      download: { source: "hf", repo: "org/qwen3-8b", file: "qwen3-8b-Q4_K_M.gguf" },
    };
    const payload = buildDuplicatePayload("qwen3-8b-copy", EMPTY, source, {});
    expect(payload.download).toEqual(source.download);
  });

  it("源模型无 download → 结果里不存在该键（而非键存在值为 undefined）", () => {
    const payload = buildDuplicatePayload("qwen3-8b-copy", EMPTY, BASE, {});
    expect("download" in payload).toBe(false);
  });

  it("mmproj 空串 → 结果里不存在 mmproj_file 键；非空则透传 trim 后的值", () => {
    const empty = buildDuplicatePayload("qwen3-8b-copy", EMPTY, BASE, {});
    expect("mmproj_file" in empty).toBe(false);

    const withMmproj = buildDuplicatePayload(
      "qwen3-8b-copy",
      { ...EMPTY, mmproj: " main/mmproj-F16.gguf " },
      BASE,
      {},
    );
    expect(withMmproj.mmproj_file).toBe("main/mmproj-F16.gguf");
  });

  it("name / 参数字段按草稿与 overrides 组装，name 与 gguf_file 去除首尾空白", () => {
    const drafts = { ...EMPTY, displayName: " Qwen3 8B（副本） ", ggufFile: " main/qwen3-8b-Q4_K_M.gguf " };
    const overrides = { server: { ctx_size: 65536 } };
    const payload = buildDuplicatePayload(" qwen3-8b-64k ", drafts, BASE, overrides);
    expect(payload).toMatchObject({
      name: "qwen3-8b-64k",
      display_name: "Qwen3 8B（副本）",
      namespace: BASE.namespace,
      gguf_file: "main/qwen3-8b-Q4_K_M.gguf",
      overrides,
    });
  });
});

describe("切分参数的草稿三态（多卡支持批次）", () => {
  const WITH_SPLIT: ModelConfig = {
    ...BASE,
    overrides: { server: { split_mode: "layer", tensor_split: "3,1", main_gpu: 1 } },
  };

  it("initDrafts 读出已有覆盖", () => {
    const d = initDrafts(WITH_SPLIT);
    expect(d.splitMode).toBe("layer");
    expect(d.tensorSplit).toBe("3,1");
    expect(d.mainGpu).toBe("1");
  });

  it("无覆盖时三者均为空串（= 跟随默认，不下发）", () => {
    expect(EMPTY.splitMode).toBe("");
    expect(EMPTY.tensorSplit).toBe("");
    expect(EMPTY.mainGpu).toBe("");
  });

  it("deriveOverrides 往返一致", () => {
    expect(deriveOverrides(initDrafts(WITH_SPLIT)).server).toMatchObject({
      split_mode: "layer",
      tensor_split: "3,1",
      main_gpu: 1,
    });
  });

  it("main_gpu 为 0 必须保留（0 是第一张卡，不是「未设置」）", () => {
    expect(deriveOverrides({ ...EMPTY, mainGpu: "0" }).server).toMatchObject({ main_gpu: 0 });
  });

  it("空串不产出键（清空输入框 = 取消覆盖）", () => {
    const server = deriveOverrides({ ...EMPTY, splitMode: "", tensorSplit: "", mainGpu: "" }).server ?? {};
    expect("split_mode" in server).toBe(false);
    expect("tensor_split" in server).toBe(false);
    expect("main_gpu" in server).toBe(false);
  });
});
