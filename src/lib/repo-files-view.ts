import { detectQuant } from "@/core/files";
import { groupIdentityKey, type QuantGroup } from "@/core/quant";
import type { DriftState } from "./version-drift";

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
   *  不逼着每处调用方/测试夹具都补上这个字段，缺省按「不参与任何共用组」处理。
   *  `drift` 是本地这份与远端当前版本的关系（`compareToRemote` 的结果，规格
   *  §5.1），由路由侧逐条算好喂进来——本函数不做任何比对，只负责按组聚合。
   *  留成可选，与 `sharedWith` 同款理由：旧夹具/未接线的调用方不必逐个补齐，
   *  缺省视同「没有比对过」（落进 unverified 而非 hasUpdate，见下方累加逻辑） */
  local: Array<{ rel: string; size: number; sharedWith?: string[]; drift?: DriftState }>;
  /** `inRepoDir` 是 scanRepoFiles/route 响应里就有的字段（任务 11 起标出所属
   *  档案）：本函数据它把散落位置拆成「可归位」与「在别的档案里」两路
   *  （见 RepoRow.relocatableRels）。留成可选，缺省按 null（游离、可归位）
   *  处理——那正是任务 11 之前的唯一形态，旧夹具不必逐个补齐 */
  // `drift` 本轮未消费，仅补齐与路由响应的类型对齐（GET /repos/:id/files 早就
  // 在发这个字段，见 repo-detail-view.tsx 的 RepoFilesResponse.strays）
  strays: Array<{ file: string; rel: string; size: number; inRepoDir?: string | null; drift?: DriftState }>;
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
  /** basename 命中散落候选、但没有一个候选的 size 恰好等于远端声明的这个
   *  文件大小——I4 精确门收不下的那部分，与之互补而非重叠（I4 收 size 相等
   *  的，这里收 size 不等的）。远端声明 size 非正数时同样不记（与 I4 同一条
   *  件）。不进 strayRels/relocatableRels，state 仍按原规则走（这类行仍是
   *  "absent"）——这里纯粹是给行上补一句"本机有同名但版本不符"的说明用的
   *  （复核修复 K-1，规格 §1① / §5.2 / §12 验收第 1 条）。同一远端文件若有
   *  多个 size 都不符的候选，取与远端声明大小差值最小的那个 */
  driftStrays: { rel: string; localSize: number; remoteSize: number }[];
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
  /** 组内有文件确定不是远端当前版本（规格 §5.1）。state 仍是 present——
   *  它确实已下载，只是版本旧了，显示成「未下载」会把这条信息弄丢 */
  hasUpdate: boolean;
  /** 组内有文件拿不到 oid、无从判定版本；与 hasUpdate 互斥展示（有更新优先） */
  unverified: boolean;
  /** 本组内已在本地找到的文件的实测大小之和（`local[].size`，按组内匹配到
   *  的文件累加，partial 行只累加已到齐的那几片）。一片都没匹配到时为
   *  `null`——不用 0，0 是「量出来的大小恰好是零字节」，与「压根没量到」
   *  是两件事，不能用同一个值表示；`localOnlyRows` 降级路径每行只有一个
   *  文件，恒等于该文件的 size */
  localSize: number | null;
  /** 远端声明的组总大小（`group.totalSize`）。远端不可达时（`localOnlyRows`
   *  降级路径）没有这个基准，为 `null`——与 `localSize` 同一套「量不到就是
   *  null，不是 0」的口径，供后续任务用两者的差值渲染「版本不符（大 …）」
   *  之类的提示 */
  remoteSize: number | null;
}

/** 设计 §9.3 状态表：暂停的任务仍留着半成品和一个「继续」入口，与
 *  pending/downloading 一样算「进行中」；只有终态（completed/failed/
 *  cancelled）才不算——显示成「未下载」会把这条信息弄丢 */
const IN_PROGRESS_STATUSES = new Set(["pending", "downloading", "paused"]);

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function mergeRepoRows(input: RepoRowInput): RepoRow[] {
  const localByName = new Map<string, { rel: string; size: number; sharedWith?: string[]; drift?: DriftState }>();
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
    // drift 三态累加：sawDrift 区分「比对过、结果是 same/unknown」与「压根没
    // 比对过」（旧夹具/未接线调用方 drift 全程 undefined）——两者都不产生
    // hasUpdate，但只有前者算 unverified，否则第三条用例（drift 全缺省）会
    // 被误判成「有文件拿不到 oid」
    let sawDrift = false;
    let anyDifferent = false;
    let anyUnknown = false;
    let localSizeSum = 0;
    let anyLocalMatched = false;
    const strayRels: string[] = [];
    const relocatableRels: string[] = [];
    const strayRepoDirs: string[] = [];
    const driftStrays: { rel: string; localSize: number; remoteSize: number }[] = [];
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
        localSizeSum += local.size;
        anyLocalMatched = true;
        for (const path of local.sharedWith ?? []) sharedWith.add(path);
        for (const modelName of configsByRel.get(local.rel) ?? []) models.add(modelName);
        if (local.drift !== undefined) {
          sawDrift = true;
          if (local.drift === "different") anyDifferent = true;
          else if (local.drift === "unknown") anyUnknown = true;
        }
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
        } else {
          // K-1 复核修复：basename 命中但没有一个候选 size 对得上——本机有同名
          // 文件但版本不符（最常见的一类成因），此前这条信息在这里被直接丢弃，
          // 行上完全沉默（规格 §1①/§12 验收第 1 条的头号场景）。取差值最小的
          // 候选记一条，不进 strayRels/relocatableRels——I4 的语义不变，这些
          // 候选依然不能「归位」，只是要在行上说一句
          const closest = candidates.reduce((best, c) =>
            Math.abs(c.size - file.size) < Math.abs(best.size - file.size) ? c : best,
          );
          driftStrays.push({ rel: closest.rel, localSize: closest.size, remoteSize: file.size });
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
      driftStrays,
      models: [...models],
      localRels,
      sharedWith: [...sharedWith],
      taskStatus: state === "downloading" ? taskStatus : null,
      hasUpdate: anyDifferent,
      unverified: sawDrift && !anyDifferent && anyUnknown,
      localSize: anyLocalMatched ? localSizeSum : null,
      remoteSize: group.totalSize,
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
      driftStrays: [],
      models: configsByRel.get(file.rel) ?? [],
      localRels: [file.rel],
      sharedWith: file.sharedWith ?? [],
      taskStatus: null,
      // 降级路径压根没有远端清单可比对（D18：HF 拉不到才会走到这里），
      // 版本关系无从谈起——hasUpdate/unverified 恒 false，remoteSize 恒 null，
      // localSize 就是这份本地文件的实测大小
      hasUpdate: false,
      unverified: false,
      localSize: file.size,
      remoteSize: null,
    };
  });
}

export interface RepoRowsSummary {
  /** 参与计数的量化数（不含 mmproj——它是配套投影文件，不是一个独立量化选项） */
  quantCount: number;
  downloadedCount: number;
  /** 占盘总字节数：直接取 local 之和，不经 RepoRow.totalSize——后者是"整组应
   *  该有多大"，远端失败时这个数字根本拿不到，而 local 之和永远可算，两种
   *  模式（正常/降级）用同一个口径，详情页头汇总不必分支处理。
   *  硬链接按 inode 去重（见 summarizeRepoRows） */
  totalBytes: number;
}

/**
 * 详情页头汇总行「N 个量化 · 已下载 M 个 · X GB」的判定（任务 9 裁定 3：
 * 能下沉就下沉，组件只管渲染这一行文案）。
 *
 * 占盘字节按 inode 去重（D11 此前只覆盖了列表页的 `decorateProfileStats`，
 * 详情页这一路漏了）：同一份数据在档案内被硬链接两次，磁盘只占一份，直接
 * 按 size 累加会报出双倍。判据用 `sharedWith`（scanRepoFiles 按全树 ino 建的
 * 共用清单，是对称的：A 的清单里有 B，B 的清单里也有 A）——数一个就把与它
 * 共用的路径全标记掉，组内组间一视同仁。`sharedWith` 里指向档案外的路径无害：
 * 本函数只遍历 local，标记不到的条目自然不会影响结果。
 */
export function summarizeRepoRows(
  rows: readonly RepoRow[],
  local: readonly { rel: string; size: number; sharedWith?: string[] }[],
): RepoRowsSummary {
  const modelRows = rows.filter((r) => r.kind === "model");

  const counted = new Set<string>();
  let totalBytes = 0;
  for (const file of local) {
    if (counted.has(file.rel)) continue;
    totalBytes += file.size;
    counted.add(file.rel);
    for (const rel of file.sharedWith ?? []) counted.add(rel);
  }

  return {
    quantCount: modelRows.length,
    downloadedCount: modelRows.filter((r) => r.state === "present").length,
    totalBytes,
  };
}

/**
 * 两批远端分组是否是同一份清单：长度相同、且逐项的组身份（kind + 组内文件名
 * 列表，按序）一致。
 *
 * 为什么不能只比 (quant, kind)：`core/quant.ts` 里的组按 totalSize 降序排
 * （见 groupRepoFiles 结尾），(quant, kind) 相同的组本来就可能有多个（真机
 * unsloth 仓库 `Qwen3.8-27B-Q4_0.gguf` 与 `MTP/mtp-Qwen3.8-27B-Q4_0.gguf`
 * 就都是 (Q4_0, model)）——只要它们的大小序或成员发生变化，按 (quant, kind)
 * 逐位对比就会把 A 组的下标误判成 B 组的下标。`selected` 存的正是 rows
 * 下标，判错就会把用户的勾选悄悄留在另一个量化档上，用户毫无察觉。
 *
 * 路径口径取**完整仓库内相对路径**，不像 `acquire-plan.ts` 的
 * `matchScannedGroups` 那样还要退回按 basename 比对——这里两批数据都来自
 * 同一个数据源（`GET /api/v1/repos/:id/files` 前后两次响应的
 * `remote.groups`），路径形态天然一致，不存在跨口径问题，取更严的那一档即可。
 *
 * 用途：档案详情页的 stale-while-revalidate 后台重取回来后，要不要保留用户
 * 已有的选中——`selected` 存的是 rows 下标，清单一变下标就会指向别的档，
 * 所以不能无脑保留；但 TTL 到期不代表作者真的传了新文件，绝大多数重取拿回
 * 来的其实是同一份清单，这种情况下清空选中纯属误伤（详情见
 * repo-detail-view.tsx 里 fetchDetails 的调用处）。
 *
 * 只比身份、不比其余字段——文件大小、分片数……这些变了不影响下标对应关系，
 * 不需要参与比较。
 */
export function sameGroupIdentity(
  a: readonly { kind: string; files: readonly { path: string }[] }[],
  b: readonly { kind: string; files: readonly { path: string }[] }[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (g, i) =>
      groupIdentityKey(g.kind, g.files.map((f) => f.path)) ===
      groupIdentityKey(b[i]!.kind, b[i]!.files.map((f) => f.path)),
  );
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
 * - `identityUnchanged` 为假：清单身份变了（`sameGroupIdentity` 判定），
 *   下标已经指向别的档，整体清空——这条不是本函数新加的行为，是延续
 *   sameGroupIdentity 那次修复
 * - `identityUnchanged` 为真：**不能无脑整体保留**——`fetchDetails` 同时被
 *   下载 / 归位 / 修复 / 批量建配置的成功路径复用，这些动作不改变远端量化
 *   清单本身（`sameGroupIdentity` 照样判定为「同一份」），但会改变某一行的
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

/** 一个仓库子目录下的权重行；`dir` 为空串表示仓库根目录。 */
export interface RepoDirGroup {
  dir: string;
  /** 带回 rows 里的原始下标——分组只改变呈现顺序，绝不能重新编号。这里**不再
   *  携带 row 本身**：渲染方唯一能取到行内容的办法就是 rows[entry.index]，
   *  "用回填后的克隆行去渲染"这种退化从此在类型层就写不出来（复核修复 G-2） */
  entries: { index: number }[];
}

/**
 * 把权重行按所在仓库子目录分组（纯展示，功能逻辑不变）。
 *
 * `remoteGroups` 是必填参数（哪怕值是 null/undefined 也必须显式传）：这不是
 * 疏忽，是复核修复 G-2 的关键——旧版本里"回填目录"是接线层单独一步
 * （`buildGroupingRows(rows, ...)` 算出克隆行，再传给 `groupRowsByDir`），
 * 两次变异验证证明这一步能被悄悄跳过而所有既有检查全部放行。现在回填这一步
 * 挪进本函数内部自己做，调用方只有 `groupRowsByDir(rows, remoteGroups)` 这一种
 * 写法可选——省掉第二个参数是 tsc 报错（TS2554），不再是能被跳过的一步。
 *
 * 目录键取文件路径的目录部分的完整字符串——`a/b` 就是一个组，不搭多层树。
 * 根组恒排最前，其余目录按字典序；组内保持原下标顺序。
 */
export function groupRowsByDir(
  rows: readonly RepoRow[],
  remoteGroups: readonly { files: readonly { path: string }[] }[] | null | undefined,
): RepoDirGroup[] {
  const groupingRows = buildGroupingRows(rows, remoteGroups);
  const byDir = new Map<string, number[]>();

  groupingRows.forEach((row, index) => {
    const dirs = new Set(row.files.map(dirOf));
    const dir = dirs.size === 1 ? ([...dirs][0] ?? "") : "";
    const bucket = byDir.get(dir);
    if (bucket === undefined) byDir.set(dir, [index]);
    else bucket.push(index);
  });

  return [...byDir.entries()]
    .map(([dir, indices]) => ({ dir, entries: indices.map((index) => ({ index })) }))
    .sort((a, b) => {
      if (a.dir === b.dir) return 0;
      if (a.dir === "") return -1;
      if (b.dir === "") return 1;
      return a.dir.localeCompare(b.dir);
    });
}

/** 这个仓库到底有没有子目录——没有的话档案页连视图切换器都不渲染 */
export function hasSubdirs(groups: readonly RepoDirGroup[]): boolean {
  return groups.some((g) => g.dir !== "");
}

/**
 * 按下标取远端组，并验证它与该行确实对得上（长度、逐个 basename）——
 * "rows[i] ↔ remote.groups[i]" 这条不变量的唯一判据来源（复核修复 G-4）。
 * 对不上时返回 null，调用方各自决定"回落"（`buildGroupingRows`）还是
 * "拒绝并提示"（`onConfirmUpdate`）还是"该行不显示手动关联入口"（手动关联）。
 */
export function matchedRemoteGroup<G extends { files: readonly { path: string }[] }>(
  row: Pick<RepoRow, "files">,
  remoteGroups: readonly G[] | null | undefined,
  index: number,
): G | null {
  if (remoteGroups === null || remoteGroups === undefined) return null;
  const group = remoteGroups[index];
  if (group === undefined || group.files.length !== row.files.length) return null;
  const namesMatch = group.files.every((f, i) => basename(f.path) === row.files[i]);
  return namesMatch ? group : null;
}

/**
 * 分组视图用的"克隆行"（复核修复 F-2/F-9）：RepoRow.files 在 mergeRepoRows
 * 里已按 basename 收窄——不带目录——分组要看到真实目录结构，得从远端组的完整
 * 路径回填。这段逻辑原先直接写在 repo-detail-view.tsx 组件里、没有测试覆盖：
 * 复核做了两次变异验证（把这段替换成直接用 rows、或把回填行换成原始 row）
 * 都能通过 tsc/eslint/全部既有测试，只在渲染阶段悄悄退化——下沉成纯函数、
 * 补断言，把这类退化钉死在测试里。内部复用 `matchedRemoteGroup` 判定是否
 * 对得上（复核修复 G-4），对不上时原样回落该行的 `files`（宁可退回扁平，
 * 不能标出一个张冠李戴的目录名）。
 */
export function buildGroupingRows(
  rows: readonly RepoRow[],
  remoteGroups: readonly { files: readonly { path: string }[] }[] | null | undefined,
): RepoRow[] {
  return rows.map((row, index) => {
    const group = matchedRemoteGroup(row, remoteGroups, index);
    return group === null ? row : { ...row, files: group.files.map((f) => f.path) };
  });
}

/** 仓库内相对路径的目录部分；根目录下的文件返回空串。路径口径固定用 "/"。 */
function dirOf(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i === -1 ? "" : rel.slice(0, i);
}
