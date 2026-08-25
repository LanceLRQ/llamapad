import { describe, expect, it } from "vitest";

import { diagnoseStartFailure } from "./start-advice";

describe("start-advice（UX P0 Task 9）", () => {
  it("端口占用：docker 端口绑定失败", () => {
    expect(
      diagnoseStartFailure(
        "docker: Error response from daemon: driver failed programming external connectivity: Error starting userland proxy: bind: address already in use.",
      ),
    ).toBe("portInUse");
    expect(diagnoseStartFailure("port is already allocated")).toBe("portInUse");
  });

  it("模型文件缺失：面板服务端中文文案与 gguf 路径", () => {
    expect(diagnoseStartFailure("启动模型 qwen 失败: 模型文件缺失: main/qwen.gguf")).toBe("fileMissing");
    expect(diagnoseStartFailure("open /models/a.gguf: no such file or directory")).toBe("fileMissing");
  });

  it("镜像问题：manifest 未知 / 拉取被拒", () => {
    expect(diagnoseStartFailure("pull access denied for ghcr.io/ggmlorg/llama.cpp, repository does not exist")).toBe("imageMissing");
    expect(diagnoseStartFailure("Error: manifest unknown")).toBe("imageMissing");
  });

  it("OOM：CUDA 显存耗尽与 KV 分配失败（真机 M4 样本风格）", () => {
    expect(
      diagnoseStartFailure("CUDA error: out of memory when allocating kv cache"),
    ).toBe("oom");
    expect(diagnoseStartFailure("llama_kv_cache_unified: failed to allocate buffer")).toBe("oom");
    expect(diagnoseStartFailure("cudaMalloc failed")).toBe("oom");
  });

  it("未知错误回落 unknown", () => {
    expect(diagnoseStartFailure("some random crash")).toBe("unknown");
    expect(diagnoseStartFailure("")).toBe("unknown");
  });

  it("端口优先于其他文本（秒退场景常同时含多段日志）", () => {
    const text = "llama.cpp logs... address already in use ... out of memory in earlier run";
    expect(diagnoseStartFailure(text)).toBe("portInUse");
  });
});
