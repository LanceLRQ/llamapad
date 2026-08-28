/**
 * 设置页「镜像管理」卡片的纯逻辑（自定义镜像五字段草稿转换 + 拉取时间格式化）。
 *
 * 从 image-card.tsx 下沉——draftToPatch 的空值归一化（留空 = 不写入该键，
 * 而不是空数组/空串）是最容易写错的一处：一旦写错就会把不该存在的键悄悄
 * 写进 default_config，与 T5 那处 zod .default() 被 overridesSchema.partial()
 * 意外实体化是同一类问题（本不该存在的值被意外持久化）。但此前这几个函数
 * 埋在组件文件里，vitest 的用例收集范围不含 .tsx，跟着变得不可测。
 */

import type { DockerConfig } from "@/core/schemas";

/** ISO 时间 → 本地化短格式（与命名空间卡同款 sv-SE 格式，得到 "YYYY-MM-DD HH:mm"） */
export function formatCreatedAt(iso: string): string {
  return new Date(iso).toLocaleString("sv-SE", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** 自定义镜像五字段的表单草稿：数组字段用字符串数组承载增删行编辑 */
export interface CustomDraft {
  model_mount: string;
  entrypoint: string[];
  extra_args: string[];
  args_override: string[];
  env: string[];
}

/** DockerConfig → 草稿：未设置的字段落成"空"（空串/空数组），供输入控件展示 */
export function draftFromDocker(docker: DockerConfig): CustomDraft {
  return {
    model_mount: docker.model_mount ?? "",
    entrypoint: docker.entrypoint ?? [],
    extra_args: docker.extra_args ?? [],
    args_override: docker.args_override ?? [],
    env: docker.env ?? [],
  };
}

export type CustomDockerPatch = Pick<
  DockerConfig,
  "model_mount" | "entrypoint" | "extra_args" | "args_override" | "env"
>;

/** 空行（含空白）自动丢弃，全空数组归一化为 undefined——留空即"不设置该键"，交运行时兜底 */
export function draftToPatch(draft: CustomDraft): CustomDockerPatch {
  const cleanArray = (values: string[]): string[] | undefined => {
    const trimmed = values.map((v) => v.trim()).filter((v) => v !== "");
    return trimmed.length > 0 ? trimmed : undefined;
  };
  const mount = draft.model_mount.trim();
  return {
    model_mount: mount === "" ? undefined : mount,
    entrypoint: cleanArray(draft.entrypoint),
    extra_args: cleanArray(draft.extra_args),
    args_override: cleanArray(draft.args_override),
    env: cleanArray(draft.env),
  };
}
