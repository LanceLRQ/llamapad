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
  local: Array<{ rel: string; size: number }>;
  strays: Array<{ file: string; rel: string }>;
  tasks: Array<{ file: string; status: string; downloadedBytes: number }>;
  configs: Array<{ rel: string; models: string[] }>;
  targetDir: string;
}

export type RepoRowState = "downloading" | "present" | "partial" | "stray" | "absent";

export interface RepoRow {
  quant: string | null;
  label: string;
  kind: "model" | "mmproj";
  files: string[];
  totalSize: number;
  state: RepoRowState;
  /** state === "downloading" 时的 0..1 进度；其余为 null */
  progress: number | null;
  haveShards: number;
  totalShards: number;
  /** 组内有文件散落在档案目录之外时，其中第一个的实际位置；`stray` 行必有，
   *  `partial` 行也可能有（一部分分片已到齐、另一部分散落别处）——不随 state
   *  清空，否则 partial 行会因为丢了这个位置而给不出「归位」动作，变成死胡同 */
  strayRel: string | null;
  /** 引用了本组文件的模型配置名 */
  models: string[];
  /** 本组已在档案目录内的文件的真实相对路径（按 group.files 顺序），
   *  供「创建配置」链接直接取用；未下载的文件不出现在这里 */
  localRels: string[];
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
  const localByName = new Map<string, { rel: string; size: number }>();
  for (const item of input.local) localByName.set(basename(item.rel), item);

  // 同名 stray 可能在全盘多处出现；取第一个登记的即可，展示层只需要一个
  // 可跳转的实际位置，不需要穷举
  const strayByName = new Map<string, string>();
  for (const s of input.strays) {
    if (!strayByName.has(s.file)) strayByName.set(s.file, s.rel);
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
    let strayRel: string | null = null;
    const localRels: string[] = [];
    const models = new Set<string>();

    for (const name of names) {
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
        haveShards += 1;
        progressSum += local.size;
        localRels.push(local.rel);
        for (const modelName of configsByRel.get(local.rel) ?? []) models.add(modelName);
        continue;
      }

      if (strayRel === null) {
        const rel = strayByName.get(name);
        if (rel !== undefined) strayRel = rel;
      }
    }

    const totalShards = names.length;
    const state: RepoRowState = anyProgressing
      ? "downloading"
      : totalShards > 0 && haveShards === totalShards
        ? "present"
        : haveShards > 0
          ? "partial"
          : strayRel !== null
            ? "stray"
            : "absent";

    return {
      quant: group.quant,
      label: group.label,
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
      strayRel,
      models: [...models],
      localRels,
      taskStatus: state === "downloading" ? taskStatus : null,
    };
  });
}
