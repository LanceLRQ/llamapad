import { describe, expect, it } from "vitest";
import {
  applyArgsOverridePlaceholders,
  LLAMA_REGISTRY,
  parseGpuVersionInfo,
  recommendServerVariant,
  SERVER_VARIANTS,
} from "./images";

describe("SERVER_VARIANTS / LLAMA_REGISTRY：固定清单（§5.2，不做在线枚举）", () => {
  it("仓库地址固定、九个 tag 全部为 server-* 或 server", () => {
    expect(LLAMA_REGISTRY).toBe("ghcr.io/ggml-org/llama.cpp");
    expect(SERVER_VARIANTS).toHaveLength(9);
    for (const variant of SERVER_VARIANTS) {
      expect(variant.tag === "server" || variant.tag.startsWith("server-")).toBe(true);
    }
  });

  it("包含全部规格约定的 tag/platform 对", () => {
    expect(SERVER_VARIANTS).toEqual([
      { tag: "server", platform: "cpu" },
      { tag: "server-cuda", platform: "cuda12" },
      { tag: "server-cuda13", platform: "cuda13" },
      { tag: "server-rocm", platform: "rocm" },
      { tag: "server-musa", platform: "musa" },
      { tag: "server-intel", platform: "intel" },
      { tag: "server-vulkan", platform: "vulkan" },
      { tag: "server-openvino", platform: "openvino" },
      { tag: "server-s390x", platform: "s390x" },
    ]);
  });
});

describe("parseGpuVersionInfo：解析 nvidia-smi 头部版本行", () => {
  it("本机实测样本（595.71.05 / CUDA 13.2）同时解析出两个字段", () => {
    const sample =
      "| NVIDIA-SMI 595.71.05              Driver Version: 595.71.05      CUDA Version: 13.2     |";
    expect(parseGpuVersionInfo(sample)).toEqual({ cudaVersion: "13.2", driverVersion: "595.71.05" });
  });

  it("拿不到时字段缺省为 undefined", () => {
    expect(parseGpuVersionInfo("nvidia-smi: command not found")).toEqual({
      cudaVersion: undefined,
      driverVersion: undefined,
    });
  });
});

describe("recommendServerVariant：平台自动推荐（§5.3）", () => {
  it("CUDA Version 13.2 → server-cuda13", () => {
    expect(recommendServerVariant("CUDA Version: 13.2")).toBe("server-cuda13");
  });

  it("CUDA Version 12.4 → server-cuda", () => {
    expect(recommendServerVariant("CUDA Version: 12.4")).toBe("server-cuda");
  });

  it("无 GPU / 无 nvidia-smi（null）→ server（纯 CPU）", () => {
    expect(recommendServerVariant(null)).toBe("server");
  });

  it("既无 CUDA 也无 driver 信息的文本 → server", () => {
    expect(recommendServerVariant("nvidia-smi: command not found")).toBe("server");
  });

  it("解析不到 CUDA Version 时回退 driver_version 阈值：>=580 → cuda13", () => {
    expect(recommendServerVariant("Driver Version: 595.71.05")).toBe("server-cuda13");
  });

  it("解析不到 CUDA Version 时回退 driver_version 阈值：>=525 且 <580 → cuda12", () => {
    expect(recommendServerVariant("Driver Version: 530.30.02")).toBe("server-cuda");
  });

  it("driver_version 低于 525 阈值 → server", () => {
    expect(recommendServerVariant("Driver Version: 470.57.02")).toBe("server");
  });

  it("CUDA Version 能解析但低于 12（很旧但合法）→ 直接 server，不退回 driver 阈值", () => {
    expect(recommendServerVariant("CUDA Version: 11.8\nDriver Version: 595.71.05")).toBe("server");
  });

  it("接受已解析的 GpuVersionInfo 对象，无需重新解析文本", () => {
    expect(recommendServerVariant({ cudaVersion: "12.9" })).toBe("server-cuda");
    expect(recommendServerVariant({ driverVersion: "600.1" })).toBe("server-cuda13");
    expect(recommendServerVariant({})).toBe("server");
  });
});

describe("applyArgsOverridePlaceholders：占位符替换（§5.6）", () => {
  it("替换 model_path / mmproj_path / port 三个占位符", () => {
    const result = applyArgsOverridePlaceholders(
      ["--model-path", "{{model_path}}", "--mmproj-path", "{{mmproj_path}}", "--listen-port", "{{port}}"],
      { modelPath: "/models/main/a.gguf", mmprojPath: "/models/main/mm.gguf", port: 8080 },
    );
    expect(result).toEqual([
      "--model-path",
      "/models/main/a.gguf",
      "--mmproj-path",
      "/models/main/mm.gguf",
      "--listen-port",
      "8080",
    ]);
  });

  it("mmproj 未配置时 {{mmproj_path}} 替换为空串，该项被整体丢弃（相邻标志悬空，符合设计取舍）", () => {
    const result = applyArgsOverridePlaceholders(
      ["-m", "{{model_path}}", "--mmproj", "{{mmproj_path}}", "--port", "{{port}}"],
      { modelPath: "/models/main/a.gguf", port: 8080 },
    );
    expect(result).toEqual(["-m", "/models/main/a.gguf", "--mmproj", "--port", "8080"]);
  });

  it("不含占位符的元素原样保留", () => {
    const result = applyArgsOverridePlaceholders(["--verbose"], { modelPath: "/models/x.gguf", port: 1 });
    expect(result).toEqual(["--verbose"]);
  });

  it("同一元素内出现多个占位符时全部替换", () => {
    const result = applyArgsOverridePlaceholders(["{{model_path}}:{{port}}"], {
      modelPath: "/models/x.gguf",
      port: 9000,
    });
    expect(result).toEqual(["/models/x.gguf:9000"]);
  });
});
