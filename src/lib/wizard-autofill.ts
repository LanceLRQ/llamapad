/**
 * 新建模型向导「选文件 → 自动填名字/mmproj」的纯逻辑（批 D 第 2 条）。
 *
 * 拆成三层：
 * - `suggestNamesFromFile` / `pickSiblingMmproj`：从选中的文件本身推导建议值，
 *   不关心用户是否已经改过东西
 * - `applyAutofill`：单个字段「该不该覆盖」的判定——换文件时用户已经手动改过
 *   的值不能被冲掉，这是最容易出错的一段，独立成纯函数配测试
 * - `computeAutofill` / `computeInitialAutofill`：把上面两层接成向导实际要用
 *   的两个入口（换文件时 / 挂载时）
 */

import { pathForGroup, type PickerItem } from "@/lib/model-file-picker";
import { slugify } from "@/lib/repo-path";

/** 选中的 gguf 项 → 建议的模型名与显示名。
 *
 * 名字取自文件名（`item.label`）而不是目录：label 已经是去掉 glob 尾巴的
 * 展示名（分片组本就没有 .gguf 尾巴，单文件仍带着，这里统一去掉）。
 * name 走 repo-path.ts 的 slugify 满足 modelSchema.name 的字符集要求，
 * displayName 保留原始大小写。
 */
export function suggestNamesFromFile(item: PickerItem): { name: string; displayName: string } {
  const base = item.label.endsWith(".gguf") ? item.label.slice(0, -".gguf".length) : item.label;
  return { name: slugify(base), displayName: base };
}

/** 同目录下的 mmproj 候选：有多个取第一个（排序已由 buildPickerItems 定好，
 * 同目录内按 label 升序连续排列），没有则返回 null（不瞎选）。 */
export function pickSiblingMmproj(items: readonly PickerItem[], selected: PickerItem): string | null {
  const sibling = items.find((i) => i.dir === selected.dir && i.kind === "mmproj");
  return sibling?.value ?? null;
}

/** 一个受自动填充管理的字段：当前值 + 上一次自动填入的值。
 * `lastAuto` 与 `value` 相等（或 `value` 为空）代表用户还没手动碰过它。 */
export interface AutofillTracked {
  value: string;
  lastAuto: string;
}

/**
 * 换文件时单个字段该不该覆盖：`value` 仍是空串或者还是上一次自动填入的值，
 * 就说明用户没动过它，套用新建议；否则视为用户已手动改过，原样保留——
 * 且 `lastAuto` 也保持不变，这样即使之后再换文件，比较基准仍是那个
 * 用户从未接受过的旧值，不会因为巧合又被判定为"没改过"而重新覆盖。
 */
export function applyAutofill(current: AutofillTracked, suggested: string): AutofillTracked {
  if (current.value === "" || current.value === current.lastAuto) {
    return { value: suggested, lastAuto: suggested };
  }
  return current;
}

/** `computeAutofill` 管理的三个字段 */
export interface WizardAutofillFields {
  name: AutofillTracked;
  displayName: AutofillTracked;
  mmproj: AutofillTracked;
}

/** 换选文件后，对 name/displayName/mmproj 三个字段分别应用「该不该覆盖」判定。 */
export function computeAutofill(
  items: readonly PickerItem[],
  selected: PickerItem,
  current: WizardAutofillFields,
): WizardAutofillFields {
  const { name, displayName } = suggestNamesFromFile(selected);
  const mmproj = pickSiblingMmproj(items, selected) ?? "";
  return {
    name: applyAutofill(current.name, name),
    displayName: applyAutofill(current.displayName, displayName),
    mmproj: applyAutofill(current.mmproj, mmproj),
  };
}

/** 向导挂载时的初值（`?file=` 深链预选场景）：没有预选文件、或预选文件不在
 * 候选列表里（理论上不会发生，仍要有兜底）时，名字/mmproj 保持空，只有
 * ggufFile 照常写入——与「找不到就不猜」的既有口径一致。 */
export function computeInitialAutofill(
  items: readonly PickerItem[],
  initialFile: string | null,
): { ggufFile: string; name: string; displayName: string; mmproj: string } {
  const ggufFile = initialFile !== null ? pathForGroup([{ path: initialFile }]) : "";
  const item = items.find((i) => i.value === ggufFile);
  if (item === undefined) return { ggufFile, name: "", displayName: "", mmproj: "" };
  const { name, displayName } = suggestNamesFromFile(item);
  return { ggufFile, name, displayName, mmproj: pickSiblingMmproj(items, item) ?? "" };
}
