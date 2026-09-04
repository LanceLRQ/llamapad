/**
 * HF 仓库文件量化分组纯函数（M2 Task 2，无 IO）
 *
 * 输入是下载向导拉到的仓库文件列表，输出按量化格式切好的组，供 RadioCard 选择。
 * 复用 files.ts 的识别能力，不在本文件重复造正则：
 * - detectQuant(basename) → 量化标签（Q4_K_M / IQ4_XS / Q8_0 / BF16 / F16 …）
 * - shardGroup(path)     → 分片组 { prefix, total }（-0000N-of-0000M 尾部剥离）
 * - shardInfo(path)      → 分片序号（组内按 index 升序排）
 *
 * 分组键设计 = kind + quant + shardKey，三者缺一不可：
 * - quant 进键：不同量化绝不混组（Q8_0 与 Q4_K_M 各一组）
 * - shardKey 进键：同量化下多套模型各自成组——分片文件取 shardGroup 前缀
 *   （含子目录，跨目录同名分片不会误并），单文件取完整 path 兜底唯一。
 *   两类 shardKey 天然不碰撞：前缀以 -0000N-of 截断、永不以 .gguf 结尾，
 *   单文件键则必以 .gguf 结尾
 * - kind 进键：mmproj 投影文件即使与模型同量化也独立成组（UI 分开渲染）
 */

import { detectQuant, shardGroup, shardInfo } from "./files";

/** 仓库内相对路径文件条目（path 可能带子目录） */
export interface RepoFile {
  path: string;
  size: number;
  oid?: string;
}

/** 一个可选下载单元：某量化的整套模型（或 mmproj）文件 */
export interface QuantGroup {
  quant: string | null; // 大写量化标签；null=未识别
  label: string; // 展示名：quant ?? "未识别"
  kind: "model" | "mmproj"; // mmproj*.gguf → mmproj
  files: RepoFile[]; // 组内文件（分片按 index 有序）
  totalSize: number;
  shards: number; // 分片总数（单文件=1，即实际文件数）
  shardTotalDeclared: number | null; // 命名声明的总数（-of-0000M）；与 files.length 不符时 UI 提示缺片
}

/** path 的 basename（HF 仓库路径固定用 / 分隔） */
function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** 累积阶段的桶：files 与 indices 平行，收齐后按分片序号排序 */
interface Bucket {
  kind: "model" | "mmproj";
  quant: string | null;
  shardKey: string; // 分片前缀（分片文件）或完整 path（单文件）
  declared: number | null; // 命声明的分片总数；单文件 null
  files: RepoFile[];
  indices: number[]; // 与 files 平行；单文件恒 0（稳定排序保持输入序）
}

/** 把仓库文件列表按量化格式分组（纯函数，不修改入参） */
export function groupRepoFiles(files: RepoFile[]): QuantGroup[] {
  // 仅 .gguf 进入分组，safetensors/bin/md/png 等直接排除
  const buckets = new Map<string, Bucket>();

  for (const file of files) {
    if (!file.path.toLowerCase().endsWith(".gguf")) continue;

    const name = basename(file.path);
    const kind: Bucket["kind"] = name.toLowerCase().startsWith("mmproj") ? "mmproj" : "model";
    const quant = detectQuant(name);

    const group = shardGroup(file.path); // prefix 含子目录，跨目录同名不误并
    const shardKey = group !== null ? group.prefix : file.path;
    const index = group !== null ? (shardInfo(file.path)?.index ?? 0) : 0;

    // JSON 键序列化杜绝分隔符与 path 内容碰撞
    const key = JSON.stringify([kind, quant, shardKey]);
    const bucket = buckets.get(key);
    if (bucket === undefined) {
      buckets.set(key, {
        kind,
        quant,
        shardKey,
        declared: group !== null ? group.total : null,
        files: [file],
        indices: [index],
      });
    } else {
      bucket.files.push(file);
      bucket.indices.push(index);
    }
  }

  const groups: QuantGroup[] = [...buckets.values()].map((b) => {
    const order = b.indices
      .map((index, i) => [index, i] as const)
      .sort((x, y) => x[0] - y[0]) // 分片按 index 升序；稳定排序保持同 index 输入序
      .map(([, i]) => b.files[i]);
    return {
      quant: b.quant,
      label: b.quant ?? "未识别",
      kind: b.kind,
      files: order,
      totalSize: order.reduce((sum, file) => sum + file.size, 0),
      shards: order.length,
      shardTotalDeclared: b.declared,
    };
  });

  // 模型组在前、mmproj 组在后，各自按 totalSize 降序（大文件组靠前）
  const bySizeDesc = (a: QuantGroup, b: QuantGroup) => b.totalSize - a.totalSize;
  return [
    ...groups.filter((g) => g.kind === "model").sort(bySizeDesc),
    ...groups.filter((g) => g.kind === "mmproj").sort(bySizeDesc),
  ];
}

/**
 * 组身份序列化：kind + 组内文件名列表。
 *
 * 与上面 `groupRepoFiles` 的分桶键 `[kind, quant, shardKey]` 是两回事，别混：
 * 分桶键是"怎么把文件聚成组"的输入侧口径（决定同一批文件如何被切分）；这里
 * 的 `groupIdentityKey` 是下游判据——"两个组是不是同一个组"，用于跨两次
 * 取数结果做身份比对（`acquire-plan.ts` 的 `matchScannedGroups`、
 * `repo-files-view.ts` 的 `sameGroupIdentity`）。
 *
 * 故意不含 quant：quant 是 `detectQuant(basename)` 从文件名派生出来的标签，
 * 文件名列表相同则 quant 必然相同，写进键只会让同一个组算出两个不同的键
 * （尤其 quant 为 null 时更容易踩到）。
 *
 * 用 JSON 序列化而不是拼分隔符：与分桶键注释同一个理由，杜绝分隔符跟文件名
 * 内容本身碰撞（比如文件名里就带逗号）。
 *
 * 顺序敏感是有意的：两处调用方拿到的文件名列表都源自 `groupRepoFiles` 按
 * 分片 index 升序产出的结果，顺序本身就是身份的一部分——分片错位也应该被
 * 判成不同身份。
 */
export function groupIdentityKey(kind: string, fileNames: readonly string[]): string {
  return JSON.stringify([kind, fileNames]);
}
