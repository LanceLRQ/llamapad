import { detectQuant } from "@/core/files";
import type { QuantGroup } from "@/core/quant";

/**
 * 档案详情页四路数据合并（批 4 任务 8）：远端量化分组 + 本地已有文件 + 进行中
 * 下载任务 + 配置引用，四路各自独立取数（GET /api/v1/repos/:id/files 的
 * JSDoc 写了完整响应形状），落地前先在这里拧成一行一态，UI 只管渲染。
 *
 * 三处匹配一律按 basename：group.files[].path 是仓库内相对路径（可能带
 * 子目录），local[].rel 是 models 根相对路径，两者只有 basename 可比；
 * strays[].file 与 tasks[].file 服务端已经是 basename。
 */

/** 与 GET /api/v1/repos/:id/files 响应逐字段对齐——任务 9 把该响应原样喂给
 *  mergeRepoRows，两侧各自声明类型会在运行时才暴露脱节（批 2 吃过的亏），
 *  这里不重新声明一套。tasks[].status 服务端给六态字符串，用 string 收，
 *  不照抄成联合类型 */
export interface RepoRowInput {
  groups: QuantGroup[];
  /** `sharedWith` 来自 scanRepoFiles（任务 15，设计 §9.1 共用标注）——留成可选，
   *  不逼着每处调用方/测试夹具都补上这个字段，缺省按「不参与任何共用组」处理 */
  local: Array<{ rel: string; size: number; sharedWith?: string[] }>;
  /** `inRepoDir` 是 scanRepoFiles/route 响应里就有的字段（任务 11 起标出所属
   *  档案）：本函数据它把散落位置拆成「可归位」与「在别的档案里」两路
   *  （见 RepoRow.relocatableRels）。留成可选，缺省按 null（游离、可归位）
   *  处理——那正是任务 11 之前的唯一形态，旧夹具不必逐个补齐 */
  strays: Array<{ file: string; rel: string; size: number; inRepoDir?: string | null }>;
  tasks: Array<{ file: string; status: string; downloadedBytes: number }>;
  configs: Array<{ rel: string; models: string[] }>;
  targetDir: string;
}

export type RepoRowState = "downloading" | "present" | "partial" | "stray" | "absent";

export interface RepoRow {
  /** null 表示未识别——UI 负责翻译（quant + i18n），不要在这里塞兜底文案，
   *  见 lib/model-file-picker.ts:11-12 同一条踩过的坑 */
  quant: string | null;
  kind: "model" | "mmproj";
  files: string[];
  totalSize: number;
  state: RepoRowState;
  /** state === "downloading" 时的 0..1 进度；其余为 null */
  progress: number | null;
  haveShards: number;
  totalShards: number;
  /** 组内散落在**本**档案目录之外的文件，按 group.files 顺序逐片记录（缺片处不
   *  占位，不是与 files 等长的并行数组）——多分片模型（27B/70B 全是）只认
   *  第一片会让「归位」漏搬剩下的分片，把行状态钉死在 partial。`stray` 行
   *  必非空，`partial` 行也可能非空（一部分分片已到齐、另一部分散落别处）
   *  ——不随 state 清空，否则 partial 行会因为丢了这份位置而给不出「归位」
   *  动作，变成死胡同。
   *
   *  这一路是**展示**用的全集：任务 11 起 strays 放宽成「只排除本档案」，
   *  于是它同时含游离文件与落在别的档案目录里的文件，后者不能归位（见
   *  relocatableRels） */
  strayRels: string[];
  /** strayRels 里真正可以「归位」的那些（`inRepoDir === null`，即不在任何
   *  档案目录内）。归位走 `POST /api/v1/files/move`，而 planFileMove 明确
   *  拒绝把档案目录内的文件单独移出（会让那个档案的模型配置变成悬空引用），
   *  拿混装的 strayRels[0] 去提交必然 400 INVALID_PATH，错误文案还会把一个
   *  永久条件说成竞态。为空即「这组的散落位置全在别的档案里」，只能链接 */
  relocatableRels: string[];
  /** strayRels 里落在**别的档案**目录内的那些文件所属的档案目录（去重，按
   *  出现顺序）——供 UI 标出「在另一档案」并解释为什么归位不可用（设计 §9.1）。
   *  与 `app/(panel)/files/unclaimed-table.tsx` 对 `inRepoDir !== null` 的
   *  判定同一口径 */
  strayRepoDirs: string[];
  /** 引用了本组文件的模型配置名 */
  models: string[];
  /** 本组已在档案目录内的文件的真实相对路径（按 group.files 顺序），
   *  供「创建配置」链接直接取用；未下载的文件不出现在这里 */
  localRels: string[];
  /** 本组内硬链接来的文件与之共用同一份数据的其他路径（去重，任务 15，
   *  设计 §9.1）——组内多个文件各自的 sharedWith 取并集；没有共用文件时
   *  为空数组 */
  sharedWith: string[];
  /** state === "downloading" 时，组内进行中任务的代表状态
   *  （pending / downloading / paused），供 UI 决定给「暂停」还是「继续」；
   *  其余状态为 null。组内多个任务状态不一致时取第一个非 paused 的，
   *  全是 paused 才给 paused —— 只要还有一片在下，整组就不算暂停 */
  taskStatus: string | null;
}

/** 设计 §9.3 状态表：暂停的任务仍留着半成品和一个「继续」入口，与
 *  pending/downloading 一样算「进行中」；只有终态（completed/failed/
 *  cancelled）才不算——显示成「未下载」会把这条信息弄丢 */
const IN_PROGRESS_STATUSES = new Set(["pending", "downloading", "paused"]);

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function mergeRepoRows(input: RepoRowInput): RepoRow[] {
  const localByName = new Map<string, { rel: string; size: number; sharedWith?: string[] }>();
  for (const item of input.local) localByName.set(basename(item.rel), item);

  // 同名 stray 可能在全盘多处出现，且只有其中某一个的 size 会与远端声明的
  // 该文件大小相符（I4）——取第一个登记的那个会把真正匹配的候选挡在门外：
  // 用户早先手动下过一个同名文件放在别处（size 对不上），真身其实在另一个
  // 位置，先到先得会让这个真身完全没机会被看到。必须把同名的全部收下，
  // 匹配时按 size 精确查找。
  const straysByName = new Map<string, { rel: string; size: number; inRepoDir: string | null }[]>();
  for (const s of input.strays) {
    const entry = { rel: s.rel, size: s.size, inRepoDir: s.inRepoDir ?? null };
    const list = straysByName.get(s.file);
    if (list === undefined) straysByName.set(s.file, [entry]);
    else list.push(entry);
  }

  const configsByRel = new Map<string, string[]>();
  for (const c of input.configs) configsByRel.set(c.rel, c.models);

  // 每个文件只取一条「进行中」任务：同一文件不该同时有两条进行中记录，
  // 真出现也只保留先遇到的一条，不影响状态判定
  const tasksByName = new Map<string, { status: string; downloadedBytes: number }>();
  for (const t of input.tasks) {
    if (IN_PROGRESS_STATUSES.has(t.status) && !tasksByName.has(t.file)) {
      tasksByName.set(t.file, t);
    }
  }

  return input.groups.map((group): RepoRow => {
    const names = group.files.map((f) => basename(f.path));

    let haveShards = 0;
    let progressSum = 0;
    let anyProgressing = false;
    let taskStatus: string | null = null;
    const strayRels: string[] = [];
    const relocatableRels: string[] = [];
    const strayRepoDirs: string[] = [];
    const localRels: string[] = [];
    const models = new Set<string>();
    const sharedWith = new Set<string>();

    for (const file of group.files) {
      const name = basename(file.path);
      const task = tasksByName.get(name);
      if (task !== undefined) {
        // 有进行中任务的文件按任务字节数算进度，不再看本地 size——本地那份
        // 是正在写的半成品，与任务字节数相加会把进度算过头
        anyProgressing = true;
        progressSum += task.downloadedBytes;
        if (taskStatus === null || (taskStatus === "paused" && task.status !== "paused")) {
          taskStatus = task.status;
        }
        continue;
      }

      const local = localByName.get(name);
      if (local !== undefined) {
        // localByName 的匹配不看 size：档案目录内的同名文件就是本档案的
        // 文件，大小对不上是「下坏了」，那是另一个问题，不该在这里表现成
        // 「没下载」
        haveShards += 1;
        progressSum += local.size;
        localRels.push(local.rel);
        for (const path of local.sharedWith ?? []) sharedWith.add(path);
        for (const modelName of configsByRel.get(local.rel) ?? []) models.add(modelName);
        continue;
      }

      // 任务 11 起不再「找到第一个就早退」：多分片模型每一片各自的 stray
      // 位置都要收进 strayRels，否则「归位」只搬走命中的那一片，剩下的
      // 分片永远找不到入口
      const candidates = straysByName.get(name);
      // I4 裁定：stray 只有在 basename 相同且 size 等于远端声明的该文件
      // 大小时才算数——几 GB 的 GGUF 大小撞车的概率可以忽略，大小对不上
      // 则要么是别的仓库的同名文件、要么是没下完的半成品，两种都不该
      // 归位。远端声明大小不是正数（0/缺失）时一律不匹配任何 stray：
      // 宁可显示「未下载」，也不能凭一个名字就给出「把某个不知道是什么
      // 的文件搬进来」的按钮。同名候选可能不止一个，必须在全部候选里找
      // size 相符的那个，不能只看第一个（见上方 straysByName 头注释）
      if (candidates !== undefined && file.size > 0) {
        const match = candidates.find((c) => c.size === file.size);
        if (match !== undefined) {
          strayRels.push(match.rel);
          // 两路都要留：可归位的进 relocatableRels 供「归位」按钮取用，
          // 在别的档案里的记下所属档案供 UI 解释（丢掉它等于丢掉「同一份
          // 文件已经在另一个档案里」这条本批最值钱的信息）
          if (match.inRepoDir === null) relocatableRels.push(match.rel);
          else if (!strayRepoDirs.includes(match.inRepoDir)) strayRepoDirs.push(match.inRepoDir);
        }
      }
    }

    const totalShards = names.length;
    const state: RepoRowState = anyProgressing
      ? "downloading"
      : totalShards > 0 && haveShards === totalShards
        ? "present"
        : haveShards > 0
          ? "partial"
          : strayRels.length > 0
            ? "stray"
            : "absent";

    return {
      quant: group.quant,
      kind: group.kind,
      files: names,
      totalSize: group.totalSize,
      state,
      progress:
        state === "downloading"
          ? group.totalSize > 0
            ? Math.min(1, Math.max(0, progressSum / group.totalSize))
            : 0
          : null,
      haveShards,
      totalShards,
      strayRels,
      relocatableRels,
      strayRepoDirs,
      models: [...models],
      localRels,
      sharedWith: [...sharedWith],
      taskStatus: state === "downloading" ? taskStatus : null,
    };
  });
}

/** 远端不可达时（`GET /api/v1/repos/:id/files` 的 `remote.ok === false`）喂给
 *  {@link localOnlyRows} 的输入——只剩本地已有文件与配置引用两路，`strays`/
 *  `tasks` 不参与（任务 9 裁定 2：远端失败时一律不显示「在别处」，避免宽口径
 *  误报；进行中任务此时也无法归属到具体量化分组，与其猜不如不显示） */
export interface LocalOnlyRowInput {
  local: Array<{ rel: string; size: number; sharedWith?: string[] }>;
  configs: Array<{ rel: string; models: string[] }>;
}

/**
 * 降级渲染（设计 D18 / 任务 9 裁定 2）：HF 清单拉不到时，量化分组无从谈起——
 * 分组依赖远端文件名（识别哪几个分片属于同一量化），这里退而求其次，每个
 * 本地已有文件独立成一行，state 恒为 present，让用户仍能看到下过什么、
 * 仍能点「创建配置」，不至于因为一次网络抖动就白屏。
 */
export function localOnlyRows(input: LocalOnlyRowInput): RepoRow[] {
  const configsByRel = new Map<string, string[]>();
  for (const c of input.configs) configsByRel.set(c.rel, c.models);

  return input.local.map((file): RepoRow => {
    const name = basename(file.rel);
    const quant = detectQuant(name);
    // 与 core/quant.ts groupRepoFiles 同一条 mmproj 识别规则：降级路径没有
    // 分组可用，但 kind 判定本身不依赖分组，独立复用这一条规则即可
    const kind: RepoRow["kind"] = name.toLowerCase().startsWith("mmproj") ? "mmproj" : "model";
    return {
      quant,
      kind,
      files: [name],
      totalSize: file.size,
      state: "present",
      progress: null,
      haveShards: 1,
      totalShards: 1,
      strayRels: [],
      relocatableRels: [],
      strayRepoDirs: [],
      models: configsByRel.get(file.rel) ?? [],
      localRels: [file.rel],
      sharedWith: file.sharedWith ?? [],
      taskStatus: null,
    };
  });
}

export interface RepoRowsSummary {
  /** 参与计数的量化数（不含 mmproj——它是配套投影文件，不是一个独立量化选项） */
  quantCount: number;
  downloadedCount: number;
  /** 占盘总字节数：直接取 local 之和，不经 RepoRow.totalSize——后者是"整组应
   *  该有多大"，远端失败时这个数字根本拿不到，而 local 之和永远可算，两种
   *  模式（正常/降级）用同一个口径，详情页头汇总不必分支处理 */
  totalBytes: number;
}

/**
 * 详情页头汇总行「N 个量化 · 已下载 M 个 · X GB」的判定（任务 9 裁定 3：
 * 能下沉就下沉，组件只管渲染这一行文案）。
 */
export function summarizeRepoRows(
  rows: readonly RepoRow[],
  local: readonly { rel: string; size: number }[],
): RepoRowsSummary {
  const modelRows = rows.filter((r) => r.kind === "model");
  return {
    quantCount: modelRows.length,
    downloadedCount: modelRows.filter((r) => r.state === "present").length,
    totalBytes: local.reduce((sum, f) => sum + f.size, 0),
  };
}

/**
 * 两批远端分组是否是同一份清单：长度相同、且逐项的 (quant, kind) 按序一致。
 *
 * 用途：档案详情页的 stale-while-revalidate 后台重取回来后，要不要保留用户
 * 已有的选中——`selected` 存的是 rows 下标，清单一变下标就会指向别的档，
 * 所以不能无脑保留；但 TTL 到期不代表作者真的传了新文件，绝大多数重取拿回
 * 来的其实是同一份清单，这种情况下清空选中纯属误伤（详情见
 * repo-detail-view.tsx 里 fetchDetails 的调用处）。
 *
 * 只比 (quant, kind, 顺序) 三样——这三样恰好决定了 mergeRepoRows 产出的
 * rows 下标序列，其余字段（文件大小、分片数……）变了不影响下标对应关系，
 * 不需要参与比较。
 */
export function sameQuantIdentity(
  a: readonly { quant: string | null; kind: string }[],
  b: readonly { quant: string | null; kind: string }[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, i) => item.quant === b[i].quant && item.kind === b[i].kind);
}

/** 可勾选的状态：已下载/下载中的行没什么好选的；在别处（stray）的行任务 9
 *  时只给「归位」按钮，本批（任务 11）起放开——扫描已经覆盖到别的档案目录，
 *  一组 stray 现在可能对应「链接过来」而不只是「归位（移过来）」，具体走
 *  哪条路径由后续任务的 acquire 提交入口落地，这里先放开可勾选这一步。
 *  从 repo-detail-view.tsx 挪到这里导出，供 retainedSelection 复用同一条
 *  判定，不重复写一遍容易漂移的条件 */
export function isSelectable(row: RepoRow): boolean {
  return row.state === "absent" || row.state === "partial" || row.state === "stray";
}

/**
 * 重取清单后仍应保留的选中下标。
 *
 * - `identityUnchanged` 为假：清单身份变了（`sameQuantIdentity` 判定），
 *   下标已经指向别的档，整体清空——这条不是本函数新加的行为，是延续
 *   sameQuantIdentity 那次修复
 * - `identityUnchanged` 为真：**不能无脑整体保留**——`fetchDetails` 同时被
 *   下载 / 归位 / 修复 / 批量建配置的成功路径复用，这些动作不改变远端量化
 *   清单本身（`sameQuantIdentity` 照样判定为「同一份」），但会改变某一行的
 *   下载状态（如 `absent` → `downloading`）。这类行在新一轮 `nextRows` 里
 *   已经不是 `isSelectable`，勾选框会因此禁用，但如果 `selected` 仍然存着
 *   它的下标，"下载选中项" 按钮只看 `selected.size` 不看是否仍可选，会照样
 *   可点——再点一次就会把同一个文件重新入队下载。所以要按 `isSelectable`
 *   逐个下标剪枝，只留仍然真实可选（`absent`/`partial`/`stray`）的那些
 */
export function retainedSelection(
  selected: ReadonlySet<number>,
  nextRows: readonly RepoRow[],
  identityUnchanged: boolean,
): Set<number> {
  if (!identityUnchanged) return new Set();
  const kept = new Set<number>();
  for (const index of selected) {
    const row = nextRows[index];
    if (row !== undefined && isSelectable(row)) kept.add(index);
  }
  return kept;
}
