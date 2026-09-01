/**
 * 模型编辑页 / 另存为页二级栏纯逻辑层（M16 T9 起分节，本批把原 01–04 四格合并成
 * 一格「配置」）：`?tab=` 深链解析。对齐 lib/settings-tabs.ts、
 * lib/wizard-steps.ts 的既有做法（vitest 是 environment: "node"，组件渲染测不了，
 * 可测判定一律下沉到这里配 .test.ts）。
 *
 * 编辑页三格（配置 / 生效参数预览 / 危险区）与另存为页两格（无危险区）共用同一个
 * ModelFormSection 联合类型，靠 EDIT_SECTIONS / DUPLICATE_SECTIONS 两份固定
 * 有序集合区分——resolveModelFormSection 因此必须收 sections 参数：另存为页
 * 根本没有危险区这一格，`?tab=danger` 落在这页上不能解析成一个不存在的分节
 * （那会渲染出空白），必须落回 config。
 *
 * 「配置」原本是基本信息/Docker/性能参数/采样参数四个独立分节，本批合并成一格——
 * 页内四张卡纵向排列，不再各占一个二级栏条目。旧的四个 key 因此不再是合法分节，
 * 但它们可能仍活在用户收藏的旧链接、文档截图里：LEGACY_SECTION_ALIASES 把它们
 * 显式映射到 "config"，不靠「非法值兜底」歪打正着——巧合与故意的向后兼容，
 * 读代码的人分不出来，写成映射表就分得出来。
 */

export type ModelFormSection = "config" | "preview" | "danger";

/** 编辑页三格：配置（合并原基本信息/Docker/性能/采样四格）/ 生效参数预览 / 危险区。
 * 危险区前导位是警告图标，不是编号，number 留空串——页面组件据此判断走 icon 型
 * lead 还是 number 型 lead */
export const EDIT_SECTIONS: readonly { key: ModelFormSection; number: string }[] = [
  { key: "config", number: "01" },
  { key: "preview", number: "02" },
  { key: "danger", number: "" },
];

/** 另存为页两格：编辑页去掉危险区——新模板还不存在，没有「删除」这回事 */
export const DUPLICATE_SECTIONS: readonly { key: ModelFormSection; number: string }[] =
  EDIT_SECTIONS.filter((section) => section.key !== "danger");

export const DEFAULT_MODEL_FORM_SECTION: ModelFormSection = "config";

/** 合并前的四格 key → 合并后 "config" 的映射：`?tab=basic` / `?tab=docker` /
 * `?tab=perf` / `?tab=sampling` 都要落到合并后的那一格，而不是被当成非法值
 * 兜底到 DEFAULT_MODEL_FORM_SECTION——两者当前结果碰巧相同（DEFAULT 也是
 * "config"），但写成显式映射能保证这四个旧值的兼容行为不会被将来悄悄改动
 * DEFAULT 时无声带歪，也让读代码的人一眼看出这是刻意保留的向后兼容，不是巧合。 */
const LEGACY_SECTION_ALIASES: Readonly<Record<string, ModelFormSection>> = {
  basic: "config",
  docker: "config",
  perf: "config",
  sampling: "config",
};

/** URL 里的 `?tab=` 落到实际分节：旧四格 key 先查 LEGACY_SECTION_ALIASES 映射到
 * "config"；其余非法值、以及在 sections 里根本不存在的合法值（另存为页收到
 * "danger"）一律落回 config，与 resolveSettingsTab 同一套兜底思路 */
export function resolveModelFormSection(
  raw: string | undefined,
  sections: readonly { key: ModelFormSection }[],
): ModelFormSection {
  const aliased = raw !== undefined ? LEGACY_SECTION_ALIASES[raw] : undefined;
  const target = aliased ?? raw;
  const hit = sections.find((section) => section.key === target);
  return hit ? hit.key : DEFAULT_MODEL_FORM_SECTION;
}
