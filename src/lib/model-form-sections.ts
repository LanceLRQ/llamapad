/**
 * 模型编辑页 / 另存为页二级栏纯逻辑层（M16 T9）：`?tab=` 深链解析 + 分节覆盖计数。
 * 对齐 lib/settings-tabs.ts、lib/wizard-steps.ts 的既有做法（vitest 是
 * environment: "node"，组件渲染测不了，可测判定一律下沉到这里配 .test.ts）。
 *
 * 编辑页六格（01–05 + 危险区）与另存为页五格（无危险区）共用同一个
 * ModelFormSection 联合类型，靠 EDIT_SECTIONS / DUPLICATE_SECTIONS 两份固定
 * 有序集合区分——resolveModelFormSection 因此必须收 sections 参数：另存为页
 * 根本没有危险区这一格，`?tab=danger` 落在这页上不能解析成一个不存在的分节
 * （那会渲染出空白），必须落回 basic。
 */

import { SAMPLING_KEYS } from "@/lib/model-form";

export type ModelFormSection = "basic" | "docker" | "perf" | "sampling" | "preview" | "danger";

/** 编辑页六格：01–05 编号 + 危险区。危险区前导位是警告图标，不是编号，
 * number 留空串——页面组件据此判断走 icon 型 lead 还是 number 型 lead */
export const EDIT_SECTIONS: readonly { key: ModelFormSection; number: string }[] = [
  { key: "basic", number: "01" },
  { key: "docker", number: "02" },
  { key: "perf", number: "03" },
  { key: "sampling", number: "04" },
  { key: "preview", number: "05" },
  { key: "danger", number: "" },
];

/** 另存为页五格：编辑页去掉危险区——新模板还不存在，没有「删除」这回事 */
export const DUPLICATE_SECTIONS: readonly { key: ModelFormSection; number: string }[] =
  EDIT_SECTIONS.filter((section) => section.key !== "danger");

export const DEFAULT_MODEL_FORM_SECTION: ModelFormSection = "basic";

/** URL 里的 `?tab=` 落到实际分节：非法值、以及在 sections 里根本不存在的合法值
 * （另存为页收到 "danger"）一律落回 basic，与 resolveSettingsTab 同一套兜底思路 */
export function resolveModelFormSection(
  raw: string | undefined,
  sections: readonly { key: ModelFormSection }[],
): ModelFormSection {
  const hit = sections.find((section) => section.key === raw);
  return hit ? hit.key : DEFAULT_MODEL_FORM_SECTION;
}

const SAMPLING_KEY_SET = new Set<string>(SAMPLING_KEYS);

/**
 * 每一节的覆盖数：二级栏 meta 位常驻显示这个数字，参数一屏铺不完必然要滚，
 * 滚动会让「我到底改了哪些」失去全局感，meta 位把它找回来。
 *
 * 入参是 useModelParams 派生出的 overriddenKeys（"docker.xxx" / "server.xxx"
 * 形态）。采样六键复用 lib/model-form.ts 的 SAMPLING_KEYS——两处各写一份会
 * 漂移，届时会出现「性能节说 3 项覆盖、实际有一项跑到采样节去了」这种 bug。
 */
export function countSectionOverrides(
  overriddenKeys: readonly string[],
): Record<"docker" | "perf" | "sampling" | "preview", number> {
  let docker = 0;
  let perf = 0;
  let sampling = 0;
  for (const key of overriddenKeys) {
    if (key.startsWith("docker.")) {
      docker += 1;
      continue;
    }
    if (key.startsWith("server.")) {
      const field = key.slice("server.".length);
      if (SAMPLING_KEY_SET.has(field)) sampling += 1;
      else perf += 1;
    }
  }
  return { docker, perf, sampling, preview: overriddenKeys.length };
}
