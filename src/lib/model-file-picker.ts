/**
 * 模型文件选择弹层的纯逻辑（规格 §4）：文件树 → 可选项列表。
 *
 * 归并直接复用 core/quant.ts 的 groupRepoFiles——它按
 * `kind(model/mmproj) + quant + shardKey` 分组的语义正是弹层要的：
 * 同一分片组归成一项、mmproj 独立成类、识别不出量化的文件照常进组
 * （规格 §2 第 5 条「不硬过滤」在那一层就已经成立）。本模块只补四件
 * groupRepoFiles 不管的事：refs 回填、组 → 配置路径、所在目录提取、按
 * 目录与名排序。
 *
 * 不使用 groupRepoFiles 的 label 字段——它是 `quant ?? "未识别"` 的硬编码
 * 中文，弹层的文案走 next-intl。
 *
 * 目录字段命名为 `dir` 而非「命名空间」（术语拆分批次的产物）：这里的分组
 * 依据是 rel 去掉 basename 后的完整目录路径（阶段 3a 起可以是多级），纯粹
 * 是磁盘路径事实，与 models.namespace 配置字段是两回事——两者早已可能
 * 不一致（同一模型的 gguf_file 允许跨目录引用），
 * 继续叫「命名空间」会让人误以为这里在读配置分组。`main/qwen-Q4_K_M.gguf`
 * 与 `test/qwen-Q4_K_M.gguf` 在弹层里是字面完全相同的候选项——label 只取
 * basename，靠 dir 字段区分，UI 层据此分组渲染，而不是把目录也塞进 label
 * 破坏"文件名"这个展示语义。
 */

import { shardGroup } from "@/core/files";
import { groupRepoFiles } from "@/core/quant";

/** 输入：GET /api/v1/files/tree 的单个文件（结构同 filesApi.TreeFile） */
export interface PickerFile {
  /** 相对 models 根的路径，含一级目录前缀（如 main/qwen.gguf） */
  rel: string;
  size: number;
  mtime: number;
  /** 引用该文件的配置数 */
  refs: number;
}

/** 弹层里的一项：可能是单文件，也可能是归并后的整个分片组 */
export interface PickerItem {
  /** 写入 gguf_file / mmproj_file 的值（精确路径或 glob），含目录前缀 */
  value: string;
  /** 所在目录：取自文件相对路径的首段，用于分组展示与同名文件去重区分 */
  dir: string;
  /** 展示名：单文件为文件名，分片组为去掉 `-*.gguf` 的组前缀（不含目录） */
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

/** value → 展示名：glob 去掉通配尾巴，单文件取 basename（不含目录前缀） */
function labelOf(value: string): string {
  const base = value.slice(value.lastIndexOf("/") + 1);
  return base.endsWith("-*.gguf") ? base.slice(0, -"-*.gguf".length) : base;
}

/** 相对路径 → 所在目录（阶段 3a：scanTree 的 rel 现在可以是任意层级，取的是
 * 最后一个 "/" 之前的完整目录路径，不再只是首段）；根下文件（无 "/"）返回
 * 空串，与 fsScanner.FolderFiles 的 folder: "" 约定一致 */
function dirOf(rel: string): string {
  const slash = rel.lastIndexOf("/");
  return slash === -1 ? "" : rel.slice(0, slash);
}

/**
 * 文件列表 → 弹层可选项。排序：模型项在前、mmproj 项在后，各自先按目录
 * 升序再按 label 升序（规格 §4.2 的分组线框图），使同目录的项在结果里
 * 连续排列——UI 层按此连续性切分组，不需要再排一次序
 * （groupRepoFiles 内部按体积降序，这里改回按名——用户是按名字找文件的）。
 *
 * `mode: "file"`（任务 16，手动关联）：跳过分片归并，组内每个物理文件各出
 * 一项，`value` 是精确路径而不是 `pathForGroup` 的 glob——手动关联是逐文件
 * 精确指定，不是选一整组。`shardTotalDeclared` 硬置 `null`：分片名里的
 * `-of-0000M` 在单文件模式下是误导，UI 会据它渲染「缺片」警告，而这里本来
 * 就是逐片选。默认 `"group"`，既有调用方（下载向导等）行为不变。
 */
export function buildPickerItems(
  files: readonly PickerFile[],
  opts?: { mode?: "group" | "file" },
): PickerItem[] {
  const refsByRel = new Map(files.map((f) => [f.rel, f.refs]));
  const groups = groupRepoFiles(files.map((f) => ({ path: f.rel, size: f.size })));
  const mode = opts?.mode ?? "group";

  const items: PickerItem[] =
    mode === "file"
      ? groups.flatMap((g) =>
          g.files.map((f): PickerItem => ({
            value: f.path,
            dir: dirOf(f.path),
            label: labelOf(f.path),
            kind: g.kind,
            quant: g.quant,
            shards: 1,
            shardTotalDeclared: null,
            totalSize: f.size,
            refs: refsByRel.get(f.path) ?? 0,
          })),
        )
      : groups.map((g): PickerItem => {
          const value = pathForGroup(g.files);
          return {
            value,
            dir: dirOf(g.files[0]!.path),
            label: labelOf(value),
            kind: g.kind,
            quant: g.quant,
            shards: g.shards,
            shardTotalDeclared: g.shardTotalDeclared,
            totalSize: g.totalSize,
            refs: refsByRel.get(g.files[0]!.path) ?? 0,
          };
        });

  const byDirThenLabel = (a: PickerItem, b: PickerItem) => {
    if (a.dir !== b.dir) return a.dir < b.dir ? -1 : 1;
    return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
  };
  return [
    ...items.filter((i) => i.kind === "model").sort(byDirThenLabel),
    ...items.filter((i) => i.kind === "mmproj").sort(byDirThenLabel),
  ];
}

/** 按目录分组渲染用的一组：目录标题 + 组内候选项 */
export interface PickerGroup {
  dir: string;
  items: PickerItem[];
}

/**
 * 候选项 → 按目录分组（规格 §4.2）：分隔线上下两个区域各自调用一次，
 * 让每个区域都能看出文件所在目录，而不只是分隔线以上有分组。
 *
 * 要求输入按 dir 连续排列——buildPickerItems 的排序已保证这点，这里
 * 只做"遇到不同 dir 就开新组"的一次遍历，不重新排序。
 */
export function groupByDir(items: readonly PickerItem[]): PickerGroup[] {
  const groups: PickerGroup[] = [];
  for (const item of items) {
    const last = groups.at(-1);
    if (last !== undefined && last.dir === item.dir) last.items.push(item);
    else groups.push({ dir: item.dir, items: [item] });
  }
  return groups;
}
