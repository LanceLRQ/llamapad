import { describe, expect, it } from "vitest";
import type { DockerConfig } from "@/core/schemas";
import { draftFromDocker, draftToPatch, formatCreatedAt, type CustomDraft } from "./image-card-form";

/**
 * 自定义镜像五字段草稿转换（image-card-form.ts）。
 * 重点在 draftToPatch 的空值归一化：留空必须变成 undefined（不写入该键），
 * 写成空数组/空串会把不该存在的键悄悄持久化进 default_config。
 */

const BASE_DOCKER: DockerConfig = {
  image: "ghcr.io/ggml-org/llama.cpp:server-cuda",
  container_name: "llama-server",
  model_volume: "/srv/llama/models:/models",
  host_port: 18080,
  container_port: 8080,
  gpu: "all",
};

const EMPTY_DRAFT: CustomDraft = {
  model_mount: "",
  entrypoint: [],
  extra_args: [],
  args_override: [],
  env: [],
};

describe("formatCreatedAt", () => {
  it("格式化为 sv-SE 短格式 YYYY-MM-DD HH:mm", () => {
    expect(formatCreatedAt("2026-08-28T09:05:00.000Z")).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});

describe("draftFromDocker", () => {
  it("五个字段均未设置时，落成空串/空数组", () => {
    expect(draftFromDocker(BASE_DOCKER)).toEqual(EMPTY_DRAFT);
  });

  it("已设置的字段原样透传", () => {
    const docker: DockerConfig = {
      ...BASE_DOCKER,
      model_mount: "/mnt/models",
      entrypoint: ["/bin/sh", "-c"],
      extra_args: ["--verbose"],
      args_override: ["--model", "{{model_path}}"],
      env: ["FOO=bar"],
    };
    expect(draftFromDocker(docker)).toEqual({
      model_mount: "/mnt/models",
      entrypoint: ["/bin/sh", "-c"],
      extra_args: ["--verbose"],
      args_override: ["--model", "{{model_path}}"],
      env: ["FOO=bar"],
    });
  });
});

describe("draftToPatch", () => {
  it("全部留空 → 五个键都是 undefined，不是空数组/空串", () => {
    const patch = draftToPatch(EMPTY_DRAFT);
    expect(patch.model_mount).toBeUndefined();
    expect(patch.entrypoint).toBeUndefined();
    expect(patch.extra_args).toBeUndefined();
    expect(patch.args_override).toBeUndefined();
    expect(patch.env).toBeUndefined();
  });

  it("model_mount 只有空白 → 视为留空，归一化为 undefined", () => {
    expect(draftToPatch({ ...EMPTY_DRAFT, model_mount: "   " }).model_mount).toBeUndefined();
  });

  it("数组里混有空行与仅含空白的行 → 被丢弃，只留有效值", () => {
    const patch = draftToPatch({ ...EMPTY_DRAFT, extra_args: ["--verbose", "", "   ", "--foo"] });
    expect(patch.extra_args).toEqual(["--verbose", "--foo"]);
  });

  it("数组清空后（全是空行）→ undefined 而非空数组", () => {
    expect(draftToPatch({ ...EMPTY_DRAFT, env: ["", "  "] }).env).toBeUndefined();
  });

  it("数组元素前后有空白 → trim 后保留", () => {
    expect(draftToPatch({ ...EMPTY_DRAFT, entrypoint: ["  /bin/sh  "] }).entrypoint).toEqual(["/bin/sh"]);
  });

  it("model_mount 前后有空白 → trim 后保留", () => {
    expect(draftToPatch({ ...EMPTY_DRAFT, model_mount: "  /models  " }).model_mount).toBe("/models");
  });

  it("draftFromDocker → draftToPatch 往返一致：非空值经一轮转换不变形", () => {
    const docker: DockerConfig = {
      ...BASE_DOCKER,
      model_mount: "/mnt/models",
      entrypoint: ["/bin/sh", "-c"],
      extra_args: ["--verbose"],
      args_override: ["--model", "{{model_path}}"],
      env: ["FOO=bar"],
    };
    expect(draftToPatch(draftFromDocker(docker))).toEqual({
      model_mount: "/mnt/models",
      entrypoint: ["/bin/sh", "-c"],
      extra_args: ["--verbose"],
      args_override: ["--model", "{{model_path}}"],
      env: ["FOO=bar"],
    });
  });

  it("draftFromDocker → draftToPatch 往返一致：全未设置时仍是全 undefined", () => {
    expect(draftToPatch(draftFromDocker(BASE_DOCKER))).toEqual({
      model_mount: undefined,
      entrypoint: undefined,
      extra_args: undefined,
      args_override: undefined,
      env: undefined,
    });
  });
});
