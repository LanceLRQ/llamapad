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
import type { MtpKind } from "./mtp-kind";

/** 输入：GET /api/v1/files/tree 的单个文件（结构同 filesApi.TreeFile） */
export interface PickerFile {
  /** 相对 models 根的路径，含一级目录前缀（如 main/qwen.gguf） */
  rel: string;
  size: number;
  mtime: number;
  /** 引用该文件的配置数 */
  refs: number;
  /** 权重的 MTP 形态（任务 2，`lib/mtp-kind.ts`）：装配这份输入的服务端对
   *  每个 `.gguf` 候选逐个 `getGgufMeta` + `resolveMtpKind` 算好喂进来，
   *  本模块不做 IO。留成可选，与 `repo-files-view.ts` 的 `sharedWith`/
   *  `drift` 同款理由：手动关联候选池等未接线的调用方不必逐个补齐，
   *  缺省按 `"none"` 处理（非 GGUF 文件本就没有元数据可读，也落这个值） */
  mtpKind?: MtpKind;
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
  /** 权重的 MTP 形态（任务 2）：分片组取首片的值——llama.cpp 分片约定首片
   *  持有完整 KV 元数据，与 mtp-kind.ts 头注释、编辑页 firstFile 取值同一
   *  口径。来源 `PickerFile.mtpKind` 缺失时按 `"none"` 处理 */
  mtpKind: MtpKind;
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
 * 升序再按 label 升序（规格 §4.2 的分组线框图）——不传 `prefer` 时这会让
 * 同目录的项在结果里连续排列；传 `prefer`（见下）时排序改按同名优先 +
 * 体积差值，不再保证目录连续，`groupByDir` 已改成不依赖这条前提（复核
 * 修复 K-5，见其注释）
 * （groupRepoFiles 内部按体积降序，这里改回按名——用户是按名字找文件的）。
 *
 * `mode: "file"`（任务 16，手动关联）：跳过分片归并，组内每个物理文件各出
 * 一项，`value` 是精确路径而不是 `pathForGroup` 的 glob——手动关联是逐文件
 * 精确指定，不是选一整组。`shardTotalDeclared` 硬置 `null`：分片名里的
 * `-of-0000M` 在单文件模式下是误导，UI 会据它渲染「缺片」警告，而这里本来
 * 就是逐片选。默认 `"group"`，既有调用方（下载向导等）行为不变。
 *
 * F-4 复核修复：`groupRepoFiles` 只收 `.gguf`（`core/quant.ts` 直接 `continue`
 * 掉别的），但手动关联的候选池"不限名"——`mode: "file"` 时把被筛掉的文件按
 * 「未识别模型文件」补回来（`quant` 恒 `null`，`kind` 恒 `"model"`）；
 * `mode: "group"` 分支不变，既有调用方（下载向导等）行为不受影响。
 *
 * F-5 复核修复：`opts.prefer` 给出手动关联当前指向的远端文件（basename +
 * size）时，同名候选排最前、其余按与目标体积的差值升序引导排序，不传时退回
 * 原有的 `byDirThenLabel`，既有调用方零改动。
 *
 * 多用途弹层（`PickerPurpose`/`partitionByAccept`）不可违反的原则：`accept`
 * 声明的是**用途**，不是过滤器——未命中 `accept` 的候选照样留在这份列表里，
 * 只是被 `partitionByAccept` 分进 `secondary`。原因是文件类别（`kind`/
 * `mtpKind`）全靠 GGUF 元数据与文件名约定判定，两者都有判错的可能
 * （`mtp-kind.ts` 头注释举过文件名不可信的实例），把判定结果当硬过滤条件用，
 * 一旦判错就会把用户真正想选的文件从列表里彻底拿掉，连手动挑一个「不像但其实
 * 是」的候选救济的机会都没有。这条原则与本函数早先对 mmproj/非标准命名「不
 * 消失」的取舍是同一条思路，只是从「按 kind 分类展示」推广到了「按用途分类
 * 展示」。
 */
export function buildPickerItems(
  files: readonly PickerFile[],
  opts?: { mode?: "group" | "file"; prefer?: { basename: string; size: number } },
): PickerItem[] {
  const refsByRel = new Map(files.map((f) => [f.rel, f.refs]));
  // 权重的 MTP 形态按 rel 查表——缺失（未接线的调用方，如手动关联候选池）
  // 按 "none" 处理，与 PickerFile.mtpKind 头注释同一条约定
  const mtpByRel = new Map(files.map((f) => [f.rel, f.mtpKind ?? "none"] as const));
  const groups = groupRepoFiles(files.map((f) => ({ path: f.rel, size: f.size })));
  const mode = opts?.mode ?? "group";

  const items: PickerItem[] =
    mode === "file"
      ? [
          ...groups.flatMap((g) =>
            g.files.map((f): PickerItem => ({
              value: f.path,
              dir: dirOf(f.path),
              label: labelOf(f.path),
              kind: g.kind,
              quant: g.quant,
              mtpKind: mtpByRel.get(f.path) ?? "none",
              shards: 1,
              shardTotalDeclared: null,
              totalSize: f.size,
              refs: refsByRel.get(f.path) ?? 0,
            })),
          ),
          // groupRepoFiles 只收 .gguf，手动关联的候选池不限名——把它筛掉的文件
          // 按「未识别模型文件」补回来；quant 恒 null（无法用 detectQuant 之外的
          // 口径识别非 gguf 文件），kind 恒 "model"；mtpKind 同理恒 "none"——
          // 非 GGUF 文件读不出张量/层数，没有可供判定的元数据
          ...files
            .filter((f) => !f.rel.toLowerCase().endsWith(".gguf"))
            .map((f): PickerItem => ({
              value: f.rel,
              dir: dirOf(f.rel),
              label: labelOf(f.rel),
              kind: "model",
              quant: null,
              mtpKind: "none",
              shards: 1,
              shardTotalDeclared: null,
              totalSize: f.size,
              refs: refsByRel.get(f.rel) ?? 0,
            })),
        ]
      : groups.map((g): PickerItem => {
          const value = pathForGroup(g.files);
          return {
            value,
            dir: dirOf(g.files[0]!.path),
            label: labelOf(value),
            kind: g.kind,
            quant: g.quant,
            // 分片组取首片的 mtpKind——llama.cpp 分片约定首片持有完整 KV 元数据
            // （与 PickerItem.mtpKind 头注释、mtp-kind.ts 头注释同一口径）
            mtpKind: mtpByRel.get(g.files[0]!.path) ?? "none",
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

  // 手动关联候选引导排序（同名的、大小接近的排在前面做引导，但不阻断）：
  // basename 完全等于目标远端文件的排最前，其余按体积与目标大小的差值升序；
  // 同一优先级内再退回 byDirThenLabel 稳定排序。不传 prefer 时用原来的
  // byDirThenLabel，既有调用方零改动
  const prefer = opts?.prefer;
  const compareItems =
    prefer === undefined
      ? byDirThenLabel
      : (a: PickerItem, b: PickerItem) => {
          const basenameOf = (v: string) => v.slice(v.lastIndexOf("/") + 1);
          const aSame = basenameOf(a.value) === prefer.basename;
          const bSame = basenameOf(b.value) === prefer.basename;
          if (aSame !== bSame) return aSame ? -1 : 1;
          const diff = Math.abs(a.totalSize - prefer.size) - Math.abs(b.totalSize - prefer.size);
          if (diff !== 0) return diff;
          return byDirThenLabel(a, b);
        };

  return [
    ...items.filter((i) => i.kind === "model").sort(compareItems),
    ...items.filter((i) => i.kind === "mmproj").sort(compareItems),
  ];
}

/** `<ModelFilePicker>` 的 `field` prop：决定弹层这次是为哪个配置字段选文件
 *  （`PICKER_PURPOSE` 按它查用途配置）。三档复用同一份 `PickerItem[]`——
 *  `pickerItems` 在各 page.tsx 里只装配一次，同一份数组被主模型/mmproj/
 *  加速权重三个选择器实例共用，per-field 的排序取舍必须在渲染时按 field
 *  现算，不能烧进 `buildPickerItems` 的输出（那样会互相污染） */
export type PickerField = "gguf" | "mmproj" | "draft";

/**
 * 候选项的类别口径——比 `PickerItem.kind` 多切出一档。`kind === "mmproj"`
 * 直接对应 `"mmproj"`；`kind === "model"` 时再按 `mtpKind` 细分：`"sidecar"`
 * （18 张量的 MTP 挂件，装不下完整权重、不能单独当主模型跑）归独立的
 * `"mtp"` 档，`"embedded"`（内置 MTP 层的完整权重，本身就是一份能独立跑
 * 起来的主权重，见 `mtp-kind.ts` 头注释）与 `"none"` 一样仍归 `"model"`。
 * 这一档细分是「多用途」弹层的地基：draft 用途要把 sidecar 置顶，但
 * embedded 的定位始终是主权重，错归到 `"mtp"` 会让它在 gguf 用途里被
 * 排到分隔线以下，可它明明是能直接用的主权重。
 */
export type PickerKind = "model" | "mmproj" | "mtp";

export function pickerKindOf(item: Pick<PickerItem, "kind" | "mtpKind">): PickerKind {
  if (item.kind === "mmproj") return "mmproj";
  if (item.mtpKind === "sidecar") return "mtp";
  return "model";
}

/** 一次选文件的「用途」声明：`accept` 决定哪些类别算命中（命中的进
 *  `partitionByAccept` 返回的 `primary`，未命中的不会消失，见
 *  `buildPickerItems` 头注释「accept 是用途不是过滤器」那段），`prefer`
 *  决定命中类别里谁排最前 */
export interface PickerPurpose {
  /** 本次用途命中的类别；未命中的仍然出现在 secondary，不会被删掉 */
  readonly accept: readonly PickerKind[];
  /** accept 内部置顶的那一类；不给则按 accept 的书写顺序排 */
  readonly prefer?: PickerKind;
}

/**
 * `PickerField` → `PickerPurpose` 的固定映射。`draft`（加速权重）的
 * `accept` 里带上了 `"model"`——2026-09-21 真机实测：sidecar 对**不含
 * MTP 层**的主权重同样能提速 1.25 倍，也就是说能当草稿模型用的候选不止
 * sidecar 一种，主权重本身也够格，只是 sidecar 更专门所以置顶。
 */
export const PICKER_PURPOSE: Record<PickerField, PickerPurpose> = {
  gguf: { accept: ["model"], prefer: "model" },
  mmproj: { accept: ["mmproj"], prefer: "mmproj" },
  draft: { accept: ["mtp", "model"], prefer: "mtp" },
};

/**
 * 候选项按 `purpose.accept` 分成「命中，可直接选」与「未命中，折到分隔线
 * 以下」两组（组件层 `preferred` 逻辑的可测试版本——组件是 .tsx，vitest
 * 是 node 环境测不了，判定下沉在这里）。`primary` 内部排序：给了
 * `prefer` 就把那一类挪到最前，其余仍按 `accept` 数组的书写顺序排列；
 * 不给 `prefer` 就完全按 `accept` 的书写顺序。用 `Array.prototype.sort`
 * （规范保证稳定），同一类别内部维持 `buildPickerItems` 定好的原有顺序，
 * 不会因为参与了这次排序而被打乱。
 */
export function partitionByAccept(
  items: readonly PickerItem[],
  purpose: PickerPurpose,
): { primary: PickerItem[]; secondary: PickerItem[] } {
  const primary: PickerItem[] = [];
  const secondary: PickerItem[] = [];
  for (const item of items) {
    if (purpose.accept.includes(pickerKindOf(item))) primary.push(item);
    else secondary.push(item);
  }

  const order =
    purpose.prefer === undefined
      ? purpose.accept
      : [purpose.prefer, ...purpose.accept.filter((kind) => kind !== purpose.prefer)];
  const rank = new Map(order.map((kind, index) => [kind, index]));
  primary.sort((a, b) => (rank.get(pickerKindOf(a)) ?? 0) - (rank.get(pickerKindOf(b)) ?? 0));

  return { primary, secondary };
}

/** 三个类别的候选数量，恒返回三个键（没出现的类别是 0）——供 UI 的类型
 *  筛选分段控件显示计数，控件不必自己再扫一遍列表判断某个分段要不要出现 */
export function countByKind(items: readonly PickerItem[]): Record<PickerKind, number> {
  const counts: Record<PickerKind, number> = { model: 0, mmproj: 0, mtp: 0 };
  for (const item of items) counts[pickerKindOf(item)] += 1;
  return counts;
}

/**
 * 候选项按搜索词过滤（新布局右栏顶部的搜索框）。多个词按空白切分后要求
 * **全部命中**（AND 语义）——弹层里文件名常见形如 `Qwen3-8B-instruct
 * Q4_K_M`，用户习惯打多个关键词缩小范围而不是背整段文件名；命中面覆盖
 * `label`/`dir`/`value`/`quant` 四个字段，是因为用户既可能记得文件名，
 * 也可能记得放在哪个目录、或者只记得量化标签。这是用户主动输入的筛选，
 * 不受「accept 不删候选」那条原则约束——命中不了就是要从视图里消失。
 */
export function filterPickerItems(items: readonly PickerItem[], query: string): PickerItem[] {
  const trimmed = query.trim();
  if (trimmed === "") return [...items];

  const words = trimmed.toLowerCase().split(/\s+/);
  return items.filter((item) => {
    const haystacks = [item.label, item.dir, item.value, item.quant ?? ""].map((s) => s.toLowerCase());
    return words.every((word) => haystacks.some((haystack) => haystack.includes(word)));
  });
}

/**
 * 候选项按左侧目录树的选中节点过滤。`dirPath + "/"` 而不是裸前缀比较——
 * 否则 `hf/a` 会把同级的 `hf/abc` 也算进来，两者只是字符串前缀相同，
 * 目录层级上并不是父子关系。与 `filterPickerItems` 一样是用户主动点选，
 * 不受「accept 不删候选」原则约束。
 */
export function filterByDirPrefix(items: readonly PickerItem[], dirPath: string): PickerItem[] {
  if (dirPath === "") return [...items];
  return items.filter((item) => item.dir === dirPath || item.dir.startsWith(`${dirPath}/`));
}

/** 左侧目录树的一个节点：前序遍历的扁平数组里的一项，`depth` 供 UI 渲染缩进 */
export interface PickerDirNode {
  /** 目录完整路径；根节点为空串 */
  path: string;
  /** 展示名：末段目录名；被折叠的单链显示为 "hf / unsloth"；根节点为空串
   *  （UI 自行替换成「models 根」这类文案，本模块不掺进 next-intl 文案） */
  label: string;
  /** 展示缩进层级，根节点为 0 */
  depth: number;
  /** 该节点子树下的候选项总数（含所有子目录） */
  count: number;
}

/**
 * 候选项 → 左侧目录树（前序遍历的扁平数组，第一项恒为根节点）。
 *
 * 单链折叠是这里的核心取舍：models 目录常见 `hf/unsloth/Qwen3-8B-GGUF`
 * 这种三四级但每级只有一个子目录的路径（HF 下载器按 repo owner/name 建
 * 目录），逐级铺开会让树高得离谱、大半行都是「点一下才发现只有一个子
 * 目录」的空转节点。折叠规则：某目录自身没有直属文件（没有候选项的
 * `dir` 恰好等于它）且只有一个子目录，就与那个子目录合并，`label` 用
 * `" / "` 连接、`path` 取合并后最终那一级的、`depth` 取链起点的位置——
 * 合并可以连续发生，直到遇到一个自己有直属文件、没有子目录、或有多个
 * 子目录的节点为止。根节点不参与折叠：它永远代表整棵树（`dirPath === ""`
 * 时 `filterByDirPrefix` 返回全部），折进某个子目录会让「回到顶层」这个
 * 操作在树里找不到对应的一行。
 */
export function buildPickerDirTree(items: readonly PickerItem[]): PickerDirNode[] {
  // 收集出现过的目录路径 + 它们的所有中间祖先目录（根 "" 不在这个集合里，
  // 它是固定的第一项、不参与下面的折叠判定）
  const dirsWithOwnFiles = new Set<string>();
  const allDirs = new Set<string>();
  for (const item of items) {
    if (item.dir === "") continue; // 根下散落文件只计根节点 count，不产生目录节点
    dirsWithOwnFiles.add(item.dir);
    let cur = "";
    for (const segment of item.dir.split("/")) {
      cur = cur === "" ? segment : `${cur}/${segment}`;
      allDirs.add(cur);
    }
  }

  // 折叠前的原始父子关系：按目录路径的层级归组直属子目录
  const childrenOf = new Map<string, string[]>();
  for (const dir of allDirs) {
    const slash = dir.lastIndexOf("/");
    const parent = slash === -1 ? "" : dir.slice(0, slash);
    const siblings = childrenOf.get(parent);
    if (siblings === undefined) childrenOf.set(parent, [dir]);
    else siblings.push(dir);
  }
  const segmentOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

  // 从 start 出发沿单链向下折叠：自身无直属文件且只有一个子目录就并入
  // 子目录，可连续发生；返回折叠后的最终节点，以及它（折叠后）的直属
  // 子目录列表供继续递归——这份子目录列表已经是"跳过了整条折叠链"之后
  // 的下一层，不会把链上已经吞掉的中间目录重复递归一遍
  const resolveChain = (start: string, depth: number): { node: PickerDirNode; kids: string[] } => {
    const labelParts = [segmentOf(start)];
    let path = start;
    let kids = childrenOf.get(path) ?? [];
    while (!dirsWithOwnFiles.has(path) && kids.length === 1) {
      path = kids[0]!;
      labelParts.push(segmentOf(path));
      kids = childrenOf.get(path) ?? [];
    }
    return {
      node: { path, label: labelParts.join(" / "), depth, count: filterByDirPrefix(items, path).length },
      kids,
    };
  };

  const result: PickerDirNode[] = [{ path: "", label: "", depth: 0, count: items.length }];

  // 前序遍历：同级节点按折叠后的 label 升序排列（裸 `<` 比较，不用
  // localeCompare——本仓库其余排序都是裸比较，理由见 buildPickerItems
  // 里 byDirThenLabel 的同款写法，这里保持一致），再逐个递归其子目录
  const walk = (paths: string[], depth: number) => {
    const siblings = paths.map((path) => resolveChain(path, depth));
    siblings.sort((a, b) => (a.node.label < b.node.label ? -1 : a.node.label > b.node.label ? 1 : 0));
    for (const { node, kids } of siblings) {
      result.push(node);
      walk(kids, depth + 1);
    }
  };
  walk(childrenOf.get("") ?? [], 1);

  return result;
}

/**
 * 打开弹层时定位到某个文件所在的目录（如编辑页已选的主权重路径），供左栏
 * 目录树的初始 `dirPath` 使用。`filePath` 去掉 basename 后剩下的目录部分，
 * 在 `tree` 里存在同名节点就返回它，否则落回 models 根（`""`）。
 *
 * 只做精确匹配、不向上找祖先目录也够用：`buildPickerDirTree` 的单链折叠
 * 终止条件是 `resolveChain` 里的 `!dirsWithOwnFiles.has(path) && kids.length
 * === 1`——一个**有直属文件**的目录必然终止折叠链，因而必然自成一个节点、
 * 不会被并进上级的合并 label 里。而"文件所在目录"按定义就有这份直属文件
 * （这个文件本身就是），所以只要该目录出现在候选池里，树里就一定有 `path`
 * 与之完全相等的节点，不存在"目录在树里但只能匹配到它的某个折叠祖先"这种
 * 情况。匹配不上只有一种可能：用户在文本框里手输了一个尚未落盘的路径——
 * 这时候落回 models 根才是对的，不该假装定位到一个树里根本不存在的目录。
 *
 * `filePath` 可能是分片 glob（如 `prefix-*.gguf`），取目录的写法（找最后
 * 一个 "/" 之前的部分）对 glob 同样成立，不需要特判。
 */
export function resolveInitialDir(tree: readonly PickerDirNode[], filePath: string): string {
  const trimmed = filePath.trim();
  if (trimmed === "") return "";

  const slash = trimmed.lastIndexOf("/");
  if (slash === -1) return ""; // 文件就在 models 根，没有目录部分可定位

  const dir = trimmed.slice(0, slash);
  return tree.some((node) => node.path === dir) ? dir : "";
}

/**
 * `secondary` 组里实际出现过的类别，按固定顺序 `["model", "mmproj", "mtp"]`
 * 去重排列——供 UI 拼「以下不在本次可选类型内（投影文件、MTP 加速权重），
 * 仍可选」这句提示。返回固定顺序而不是出现顺序，是为了这句提示的措辞在
 * 各个用途下保持稳定，不随候选池的具体内容颠三倒四。
 */
export function listSecondaryKinds(secondary: readonly PickerItem[]): PickerKind[] {
  const order: PickerKind[] = ["model", "mmproj", "mtp"];
  const present = new Set(secondary.map((item) => pickerKindOf(item)));
  return order.filter((kind) => present.has(kind));
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
 * 用 Map 按 dir 键合并，不要求输入按 dir 连续排列（复核修复 K-5）——
 * `buildPickerItems` 带 `prefer` 时的引导排序完全不看 `dir`（按同名优先 +
 * 体积差值排序），同一个 dir 可能被其它候选隔开、出现在多个不连续的位置，
 * 原来"遇到不同 dir 就开新组"的实现会把同一个 dir 拆成多组，导致渲染层
 * （`components/models/model-file-picker.tsx`）用 dir 当 key 撞出重复 key。
 * 默认（无 `prefer`）排序下 `buildPickerItems` 产出的顺序本就按 dir 连续
 * 排列，Map 按插入顺序遍历的结果与原实现逐组顺序完全一致，这条改动对
 * 默认路径零行为变化。
 */
export function groupByDir(items: readonly PickerItem[]): PickerGroup[] {
  const byDir = new Map<string, PickerItem[]>();
  for (const item of items) {
    const bucket = byDir.get(item.dir);
    if (bucket === undefined) byDir.set(item.dir, [item]);
    else bucket.push(item);
  }
  return [...byDir.entries()].map(([dir, groupItems]) => ({ dir, items: groupItems }));
}
