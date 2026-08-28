/**
 * 模型文件选择弹层的纯逻辑（规格 §4）：文件树 → 可选项列表。
 *
 * 归并直接复用 core/quant.ts 的 groupRepoFiles——它按
 * `kind(model/mmproj) + quant + shardKey` 分组的语义正是弹层要的：
 * 同一分片组归成一项、mmproj 独立成类、识别不出量化的文件照常进组
 * （规格 §2 第 5 条「不硬过滤」在那一层就已经成立）。本模块只补三件
 * groupRepoFiles 不管的事：refs 回填、组 → 配置路径、按名排序。
 *
 * 不使用 groupRepoFiles 的 label 字段——它是 `quant ?? "未识别"` 的硬编码
 * 中文，弹层的文案走 next-intl。
 */

import { shardGroup } from "@/core/files";
import { groupRepoFiles } from "@/core/quant";

/** 输入：GET /api/v1/files/tree 的单个文件（结构同 filesApi.TreeFile） */
export interface PickerFile {
  /** 相对 models 根的路径，含命名空间前缀（如 main/qwen.gguf） */
  rel: string;
  size: number;
  mtime: number;
  /** 引用该文件的配置数 */
  refs: number;
}

/** 弹层里的一项：可能是单文件，也可能是归并后的整个分片组 */
export interface PickerItem {
  /** 写入 gguf_file / mmproj_file 的值（精确路径或 glob），含命名空间前缀 */
  value: string;
  /** 展示名：单文件为文件名，分片组为去掉 `-*.gguf` 的组前缀 */
  label: string;
  /** mmproj 投影文件与模型文件分列（前者排在后面，但一样可选） */
  kind: "model" | "mmproj";
  /** 量化标签；识别不出为 null（非标准命名，仍可选） */
  quant: string | null;
  /** 实际文件数（单文件 = 1） */
  shards: number;
  /** 命名声明的分片总数（-of-0000M）；单文件为 null。与 shards 不符即缺片 */
  shardTotalDeclared: number | null;
  /** 组内文件体积之和 */
  totalSize: number;
  /** 引用计数（组内取首个文件的值——同组分片被同一份配置的 glob 引用） */
  refs: number;
}

/**
 * 组 → 配置路径：分片命名（shardGroup 命中）存 glob = 首片前缀 + "-*.gguf"，
 * 单文件存精确路径。前缀含目录时 glob 同样带目录（与 quant.ts 的 shardKey 语义一致）。
 *
 * 下载向导与文件选择弹层共用此函数——两处规则一旦漂移，向导建出来的配置
 * 就会和弹层选出来的不是同一种形态。
 */
export function pathForGroup(files: readonly { path: string }[]): string {
  const first = files[0]!.path;
  const group = shardGroup(first);
  return group === null ? first : `${group.prefix}-*.gguf`;
}

/** value → 展示名：glob 去掉通配尾巴，单文件取 basename */
function labelOf(value: string): string {
  const base = value.slice(value.lastIndexOf("/") + 1);
  return base.endsWith("-*.gguf") ? base.slice(0, -"-*.gguf".length) : base;
}

/**
 * 文件列表 → 弹层可选项。排序：模型项在前、mmproj 项在后，各自按 label 升序
 * （groupRepoFiles 内部按体积降序，弹层改回按名——用户是按名字找文件的）。
 */
export function buildPickerItems(files: readonly PickerFile[]): PickerItem[] {
  const refsByRel = new Map(files.map((f) => [f.rel, f.refs]));
  const groups = groupRepoFiles(files.map((f) => ({ path: f.rel, size: f.size })));

  const items = groups.map((g): PickerItem => {
    const value = pathForGroup(g.files);
    return {
      value,
      label: labelOf(value),
      kind: g.kind,
      quant: g.quant,
      shards: g.shards,
      shardTotalDeclared: g.shardTotalDeclared,
      totalSize: g.totalSize,
      refs: refsByRel.get(g.files[0]!.path) ?? 0,
    };
  });

  const byLabel = (a: PickerItem, b: PickerItem) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0);
  return [
    ...items.filter((i) => i.kind === "model").sort(byLabel),
    ...items.filter((i) => i.kind === "mmproj").sort(byLabel),
  ];
}
