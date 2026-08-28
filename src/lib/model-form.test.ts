import { describe, expect, it } from "vitest";
import type { ModelConfig } from "@/core/schemas";
import {
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
