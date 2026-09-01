import type Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { NAMESPACE_PATTERN } from "../core/schemas";
import { rewriteRefFolder } from "../lib/file-move-plan";
import { repoDirOf } from "../lib/repo-path";
import { FileMoveError, moveFiles, type RefUpdate, type RefUpdateField } from "./fileMove";
import { buildRefMap, isExistingDir } from "./filesApi";
import {
  buildModelFileIndex,
  resolveGlobFilesFromIndex,
  resolveModelFiles,
  type ModelFile,
} from "./fsScanner";
import { createModelRepo, type StoredModel } from "./repo/models";
import { listRepoDirs } from "./repoDirs";
import type { RuntimeService } from "./runtime";

/**
 * 命名空间管理 + 模型移动服务层（M1 Task 12，设计 §5.4；阶段 1b 拆分：
 * 命名空间与文件夹彻底解耦，见下方语义段与 B1/B6 的取舍说明）
 *
 * 结构取舍：repo 层（repo/models.ts）只做纯 DB 原语（renameNamespace /
 * deleteNamespace / listNamespacesWithMeta，事务包在 repo 内）；本服务层
 * 负责跨资源编排——repo + 运行中守卫（runtime）+ events，风格对齐
 * filesApi.ts（错误码 + Error 子类供 route 映射状态码）。运行中守卫依赖
 * runtime.getRuntimeStatus()（适配器接口是 async），故 renameNamespace /
 * moveModel / moveModelFiles 为 async；纯 DB 操作保持同步。
 *
 * 语义（阶段 1b 起：命名空间与文件夹完全无关，二者多对多，靠每个模型
 * gguf_file 的目录段关联——改命名空间绝不动文件；移动文件绝不改命名空间）：
 * - 新建 = 仅 DB 行（name 唯一 + `^[a-z0-9][a-z0-9._-]*$`，目录惰性创建）
 * - 重命名 = 纯 DB 操作：repo.renameNamespace（事务）→ events；该空间有
 *   运行中模型 → 拒绝。**不再 mv 磁盘目录**（B1 修复的数据损坏缺陷：命名
 *   空间是模型配置的标签，与磁盘目录是两件事——旧实现在改标签的同时把
 *   同名目录 mv 走，却漏了同步重写 gguf_file/mmproj_file 的路径前缀，
 *   改名后配置里的路径指向一个刚被搬空的旧目录，模型直接报文件缺失。
 *   现在改标签就只改标签，磁盘文件原地不动，配置路径自然不会失真）。
 *   重命名磁盘目录的能力搬到了 folders.ts 的 renameFolder（文件页入口）
 * - 删除 = 其下无模型配置才允许，只删 DB 行；磁盘文件/目录留给文件页处理
 *   （两层解耦：先移走/删除配置，再按需清目录）。main 也允许删——用户可
 *   自由管理；main 是导入默认落点，删除后会被重建（repo 每次构造幂等
 *   确保 main 存在的既有不变量，M0 Task 5）
 * - moveModel(name, to)：纯改 namespace 字段，绝不动物理文件（跨空间引用
 *   由 gguf_file 的目录段表达，与当前 namespace 值无关）
 * - moveModelFiles(name, toFolder)：只搬物理文件 + 重写 gguf_file/mmproj_file
 *   （glob 形态保留），绝不改 namespace 字段——B6 从原 moveModel 的
 *   `moveFiles:true` 分支拆出来，目标语义从"命名空间"换成"磁盘一级目录"：
 *   不再校验目标在 namespaces 表里，改校验目标是 models 根下的既有目录
 *   （与 filesApi.planFileMove 的新口径一致，真机磁盘目录早与命名空间表
 *   脱钩，见该文件顶部注释）。物理移动 + 引用重写经 fileMove.moveFiles
 *   原语的单事务执行（设计 §2.1/§2.6）：不止改发起移动的模型自己，还会经
 *   buildRefMap 查出全部共享同一物理文件的模型一并重写，修复"共享方被
 *   静默留在旧路径"的缺陷；共享方中有运行中模型时整个移动按 LOCKED 拒绝
 *   （不能让运行中容器的配置在脚下被改）
 *
 * 只收面板视角的 models 根（panelRoot）：resolveModelFiles（面板视角 fs，
 * 含 listOverview 的 bytes 计算与 moveModelFiles 的目标目录/共享引用判定）
 * 与 moveModelFiles 的实际落盘 mv 全部走这一个根——宿主视角根在容器内不
 * 可见，只用于交给 Docker 做 bind 挂载（runtime.ts 的 createRuntimeService
 * 才需要它），面板自己的文件系统读写不该碰它（任务 H 修复的真机缺陷：
 * 曾经 moveModelFiles 用宿主视角根落盘，物理移动全部写进容器内一个看不见
 * 的位置，模型配置却按面板视角改写，两者从此对不上）。
 */

/** 业务错误码（route 据此映射 HTTP 状态码，见各 route 的 errorResponse） */
export type NamespaceErrorCode =
  | "INVALID_NAME" // 名字非法；或 moveModelFiles 待移动文件落在档案目录内（400）
  | "NOT_FOUND" // 命名空间 / 模型不存在（404）
  | "DUPLICATE" // 重名（409）
  | "CONFLICT" // moveModelFiles 目标目录已存在同名文件（409，与 filesApi CONFLICT 对齐）
  | "RUNNING" // 运行中模型守卫命中（409）
  | "NOT_EMPTY" // 命名空间下仍有模型配置（409）
  | "BAD_TARGET" // moveModel 目标命名空间不存在（400，提示先建）
  | "SAME_NAMESPACE" // rename/move 源与目标相同（400）
  | "LOCKED"; // moveModel 共享引用方含运行中模型（423，与 filesApi LOCKED 对齐）

/** 业务错误：code 供 route 映射状态码 */
export class NamespaceError extends Error {
  readonly code: NamespaceErrorCode;

  constructor(code: NamespaceErrorCode, message: string) {
    super(message);
    this.name = "NamespaceError";
    this.code = code;
  }
}

/** NamespaceError.code → HTTP 状态码（route 薄壳映射，保持本文件不依赖 next） */
export function namespaceErrorStatus(code: NamespaceErrorCode): number {
  switch (code) {
    case "INVALID_NAME":
    case "SAME_NAMESPACE":
    case "BAD_TARGET":
      return 400;
    case "NOT_FOUND":
      return 404;
    case "CONFLICT":
    case "DUPLICATE":
    case "RUNNING":
    case "NOT_EMPTY":
      return 409;
    case "LOCKED":
      return 423;
  }
}

/** listOverview 单行：设置页 / GET /api/v1/namespaces 的数据形态 */
export interface NamespaceOverview {
  name: string;
  createdAt: string;
  modelCount: number;
  /**
   * 该命名空间下全部模型（gguf_file + mmproj_file，含 glob 展开）解析出的
   * 物理文件字节数之和，按物理文件 rel 去重（同一文件被多个模型共享、或
   * 同一模型的 gguf glob 连带命中 mmproj 时只算一次）；文件缺失记 0，不
   * 视为错误（B5 改口径：命名空间与文件夹解耦后，"同名目录大小"与"该空间
   * 模型实际占用"可以差出几十倍，真机实测过 71 倍，见 listOverview 实现处注释）。
   */
  bytes: number;
}

/** 命名空间服务：面板对"命名空间 CRUD + 模型移动"的全部依赖收敛在此 */
export interface NamespaceService {
  createNamespace(name: string): void;
  /** 列表视图：DB 元数据 + 模型数 + 该空间模型引用文件的占用（同步） */
  listOverview(): NamespaceOverview[];
  renameNamespace(from: string, to: string): Promise<void>;
  deleteNamespace(name: string): void;
  /** 模型改命名空间：纯改分组标签，绝不动物理文件 */
  moveModel(name: string, to: string): Promise<StoredModel>;
  /** 模型的物理文件移动到目标文件夹：绝不改 namespace 字段 */
  moveModelFiles(name: string, toFolder: string): Promise<StoredModel>;
}

export function createNamespaceService(
  db: Database.Database,
  runtime: RuntimeService,
  roots: { panelRoot: string },
): NamespaceService {
  const repo = createModelRepo(db);
  const insertEvent = db.prepare("INSERT INTO events(ts, kind, message) VALUES (?, ?, ?)");

  /** 追加一条事件（ts 毫秒时间戳，与 runtime.ts 的 record 同款写入方式） */
  function record(kind: string, message: string): void {
    insertEvent.run(Date.now(), kind, message);
  }

  function assertValidName(name: string): void {
    if (!NAMESPACE_PATTERN.test(name)) {
      throw new NamespaceError(
        "INVALID_NAME",
        `命名空间非法（仅小写字母数字、点、下划线与连字符）: ${name}`,
      );
    }
  }

  /** 当前运行模型名（无则 null） */
  async function currentRunning(): Promise<string | null> {
    return (await runtime.getRuntimeStatus()).running?.model ?? null;
  }

  /**
   * 展开 moveModelFiles 待移动的物理文件相对路径集合：gguf glob 组 +
   * mmproj（若配置）。零命中（文件缺失）返回空集，不视为错误——重写
   * 后的路径指向"应在的位置"，物理移动本就无事可做。
   * 去重：gguf glob 可能连带命中 mmproj 文件（如 m1-*.gguf 也匹配
   * m1-mmproj.gguf），同一物理文件只登记一次（Set），避免对它 rename 两次。
   */
  function resolveMoveTargets(ggufRel: string, mmprojRel: string | undefined): Set<string> {
    const targets = new Set(resolveModelFiles(roots.panelRoot, ggufRel).files.map((f) => f.rel));
    if (mmprojRel !== undefined) {
      for (const f of resolveModelFiles(roots.panelRoot, mmprojRel).files) targets.add(f.rel);
    }
    return targets;
  }

  return {
    createNamespace(name) {
      assertValidName(name);
      if (repo.listNamespaces().includes(name)) {
        throw new NamespaceError("DUPLICATE", `命名空间已存在: ${name}`);
      }
      repo.createNamespace(name);
      record("namespace.create", `新建命名空间 ${name}`);
    },

    listOverview() {
      // B5 改口径：不再是"同名目录大小"（scanTree 按磁盘目录汇总），而是
      // "该空间下全部模型引用文件的大小之和"——命名空间与文件夹解耦后，
      // 前者与磁盘位置无关（模型的 gguf_file 可以指向任意目录），继续按
      // 目录汇总会给出一个跟真实占用毫不相干的数字（真机实测过 71 倍：
      // 一个空间下 11 个模型的文件散在别的三个目录，同名目录本身接近空）。
      // 按物理文件 rel 去重（Map 覆盖写天然去重）：同一文件被两个模型共享，
      // 或同一模型的 gguf glob 连带命中 mmproj，都只能算一次，否则虚高。
      //
      // 性能：若对每个模型的每个字段都调 resolveModelFiles，glob 值（分片
      // 模型的常态）每次都会触发一次 matchGlobDir 递归扫盘——模型一多，
      // 设置页一次打开就要把 models 树反复扫几十遍。这里先用
      // buildModelFileIndex 扫一次盘建好 rel → 文件 的索引，glob 匹配全部
      // 改在内存里用 resolveGlobFilesFromIndex 完成（复用 resolveModelFiles
      // 同一套 glob 编译结果，不是另起一套匹配语义）；精确路径本就是单次
      // statSync，仍直接用 resolveModelFiles，没必要绕索引（索引来自
      // scanTree 会跳过隐藏文件，精确路径不该受这条限制）。
      const index = buildModelFileIndex(roots.panelRoot);
      const resolve = (relPath: string): ModelFile[] =>
        relPath.includes("*") || relPath.includes("?")
          ? resolveGlobFilesFromIndex(index, relPath)
          : resolveModelFiles(roots.panelRoot, relPath).files;

      return repo.listNamespacesWithMeta().map((meta) => {
        const sizeByRel = new Map<string, number>();
        for (const model of repo.listModels(meta.name)) {
          for (const f of resolve(model.gguf_file)) sizeByRel.set(f.rel, f.size);
          if (model.mmproj_file !== undefined) {
            for (const f of resolve(model.mmproj_file)) sizeByRel.set(f.rel, f.size);
          }
        }
        const bytes = [...sizeByRel.values()].reduce((sum, size) => sum + size, 0);
        return { ...meta, bytes };
      });
    },

    async renameNamespace(from, to) {
      if (!repo.listNamespaces().includes(from)) {
        throw new NamespaceError("NOT_FOUND", `命名空间不存在: ${from}`);
      }
      assertValidName(to);
      if (to === from) {
        throw new NamespaceError("SAME_NAMESPACE", `新名字与原名相同: ${from}`);
      }
      if (repo.listNamespaces().includes(to)) {
        throw new NamespaceError("DUPLICATE", `命名空间已存在: ${to}`);
      }

      // 运行中守卫：该空间任一模型在跑即拒绝——纯改标签也拒绝，避免运行中
      // 容器的展示信息（它在哪个空间）与列表脱节
      const running = await currentRunning();
      if (running !== null && repo.listModels(from).some((m) => m.name === running)) {
        throw new NamespaceError(
          "RUNNING",
          `命名空间 ${from} 下有运行中模型 ${running}，禁止重命名（请先停止）`,
        );
      }

      // B1：纯 DB 操作，不再 mv 磁盘目录（见文件顶部注释——命名空间是标签，
      // 磁盘目录归 folders.ts 管，两者不该在同一次改名里被绑在一起处理）
      repo.renameNamespace(from, to);
      record("namespace.rename", `重命名命名空间 ${from} → ${to}`);
    },

    deleteNamespace(name) {
      if (!repo.listNamespaces().includes(name)) {
        throw new NamespaceError("NOT_FOUND", `命名空间不存在: ${name}`);
      }
      const count = repo.listModels(name).length;
      if (count > 0) {
        throw new NamespaceError(
          "NOT_EMPTY",
          `命名空间 ${name} 下仍有 ${count} 个模型配置，禁止删除（请先移走或删除配置）`,
        );
      }
      // main 同样允许删：用户自由管理。main 是导入默认落点——删除后会被
      // 重建（repo 每次构造幂等确保 main 存在，M0 Task 5 的既有不变量），
      // 因此删除生效到下一次 repo 访问为止，磁盘目录不受影响
      repo.deleteNamespace(name);
      record("namespace.delete", `删除命名空间 ${name}（仅删记录，磁盘目录保留）`);
    },

    async moveModel(name, to) {
      const model = repo.getModel(name);
      if (model === null) {
        throw new NamespaceError("NOT_FOUND", `模型不存在: ${name}`);
      }
      if (to === model.namespace) {
        throw new NamespaceError(
          "SAME_NAMESPACE",
          `目标空间与当前空间相同（${to}），模型 ${name} 无需移动`,
        );
      }
      if (!repo.listNamespaces().includes(to)) {
        throw new NamespaceError("BAD_TARGET", `目标命名空间不存在: ${to}（请先创建）`);
      }

      // 运行中守卫：改分组不动文件也拒绝——避免运行中的容器与列表展示脱节
      const running = await currentRunning();
      if (running === name) {
        throw new NamespaceError("RUNNING", `模型 ${name} 运行中，禁止移动空间（请先停止）`);
      }

      const updated = repo.updateModel(name, { namespace: to });
      record("model.move", `移动模型 ${name} ${model.namespace} → ${to}（仅改分组，文件不动）`);
      return updated;
    },

    async moveModelFiles(name, toFolder) {
      const model = repo.getModel(name);
      if (model === null) {
        throw new NamespaceError("NOT_FOUND", `模型不存在: ${name}`);
      }

      // 运行中守卫：自身运行中禁止挪它的文件（容器正占用）
      const running = await currentRunning();
      if (running === name) {
        throw new NamespaceError("RUNNING", `模型 ${name} 运行中，禁止移动文件（请先停止）`);
      }

      // B6 改口径：目标不再是 namespaces 表里的命名空间，而是 models 根下
      // 的既有磁盘目录（与 filesApi.planFileMove 的新口径一致，理由同处
      // 注释——磁盘目录与命名空间表早已脱钩，继续查 namespaces 表会把真实
      // 存在的磁盘目录当非法目标拒掉）。不自动新建：防手滑打错路径建出一堆
      // 空目录，新建目录留给后续批次。
      if (!isExistingDir(join(roots.panelRoot, toFolder))) {
        throw new NamespaceError(
          "BAD_TARGET",
          `目标目录不存在: ${toFolder}（本阶段不支持自动新建，请先在磁盘上建好目录）`,
        );
      }

      const targets = resolveMoveTargets(model.gguf_file, model.mmproj_file);

      // 档案目录守卫（批 3 第 2 项）：filesApi.planFileMove 专门加了同款守卫
      // 拦"把档案目录里的文件搬走"（档案会认不出这个文件，可能导致重复
      // 下载），但同样能搬这批文件的 move-files 此前没有这道检查。必须在
      // 任何物理改动之前判定，与下方 LOCKED / CONFLICT 同一段守卫。只挡
      // from（这批待移动的物理文件）一侧，toFolder 命中档案目录不受影响——
      // 与 planFileMove 的裁定一致，那正是详情页「归位」按钮的路径。
      const repoDirs = listRepoDirs(db);
      for (const rel of targets) {
        const repoDir = repoDirOf(rel, repoDirs);
        if (repoDir !== null) {
          throw new NamespaceError(
            "INVALID_NAME",
            `INVALID_NAME: 文件 ${rel} 位于档案目录 ${repoDir} 内，不能单独移动，请到档案页整组换存放位置`,
          );
        }
      }

      // 引用重写清单：以 modelName::field 去重——glob 组内多个物理文件可能
      // 都属于同一个引用字段，该字段只需重写一次
      const seen = new Set<string>();
      const refUpdates: RefUpdate[] = [];
      function addRefUpdate(modelName: string, field: RefUpdateField, nextValue: string): void {
        const key = `${modelName}::${field}`;
        if (seen.has(key)) return;
        seen.add(key);
        refUpdates.push({ modelName, field, nextValue });
      }

      // 发起移动的模型自身：只重写路径字段，namespace 绝不碰——这是 B6 拆分
      // 后的核心立场，文件夹与命名空间彻底无关，移动文件不该连带改变模型
      // 的分组标签（文件缺失时同样重写，保持既有行为：重写后的路径指向
      // "应在的位置"）
      addRefUpdate(name, "gguf_file", rewriteRefFolder(model.gguf_file, toFolder));
      if (model.mmproj_file !== undefined) {
        addRefUpdate(name, "mmproj_file", rewriteRefFolder(model.mmproj_file, toFolder));
      }

      // 共享引用方：查每个待移动物理文件的全部引用者一并重写——缺陷修复
      // 核心（设计 §1.1/§2.6）：现状只改发起移动的模型自己，共享同一物理
      // 文件的其它模型被静默留在旧路径，下次启动报"模型文件缺失"
      const sharedModels: string[] = [];
      const refMap = buildRefMap(db, roots.panelRoot);
      for (const rel of targets) {
        for (const ref of refMap.get(rel) ?? []) {
          if (ref.modelName === name) continue; // 自身已在上面处理
          const refModel = repo.getModel(ref.modelName);
          const oldValue = refModel?.[ref.field];
          if (oldValue === undefined) continue; // 理论不可达：refMap 来自当前库存模型
          addRefUpdate(ref.modelName, ref.field, rewriteRefFolder(oldValue, toFolder));
          sharedModels.push(ref.modelName);
        }
      }

      // 守卫：共享方中有正在运行的模型 → 整个移动按 LOCKED 拒绝（不能让
      // 运行中容器的配置在脚下被改）；自身运行中已在上面 RUNNING 分支拦截。
      // 必须在任何物理文件改动之前判定——命中时文件不能被移动。
      if (running !== null && sharedModels.includes(running)) {
        throw new NamespaceError(
          "LOCKED",
          `模型 ${name} 与运行中模型 ${running} 共享文件，禁止移动（请先停止 ${running}）`,
        );
      }

      // CONFLICT 守卫：目标目录已存在同名但不同的物理文件时禁止覆盖——
      // renameSync 对同名目标会静默覆盖，原文件永久丢失且无任何提示（与
      // filesApi.planFileMove 的 CONFLICT 守卫口径一致，见其顶部注释）。
      // 必须在任何物理文件改动之前判定，与上面的 LOCKED 守卫同一位置。
      // targetRel === rel（文件已经就在目标目录）视为原地不动，不算冲突——
      // move-files 本身没有「toFolder 不得等于当前目录」的限制，多级目录下
      // 也可能出现部分待移动文件恰好已在目标目录的情况，不跳过会把「什么
      // 都不用做」误报成冲突。
      for (const rel of targets) {
        const targetRel = `${toFolder}/${basename(rel)}`;
        if (targetRel === rel) continue;
        if (existsSync(join(roots.panelRoot, targetRel))) {
          throw new NamespaceError(
            "CONFLICT",
            `CONFLICT: 目标目录已存在同名文件: ${targetRel}`,
          );
        }
      }

      if (targets.size > 0) {
        const toDir = join(roots.panelRoot, toFolder);
        const sourceAbs = [...targets].map((rel) => join(roots.panelRoot, rel));
        const targetAbs = [...targets].map((rel) => join(toDir, basename(rel)));

        try {
          moveFiles({ db }, { from: sourceAbs, to: targetAbs, refUpdates });
        } catch (error) {
          if (error instanceof FileMoveError) {
            record(
              "model.move",
              `移动模型 ${name} 文件 → ${toFolder} 失败：${error.message}`,
            );
          }
          throw error;
        }
      } else {
        // 展开零命中：无物理文件可移，但自身路径字段仍需重写（见上）
        moveFiles({ db }, { from: [], to: [], refUpdates });
      }

      const updated = repo.getModel(name);
      if (updated === null) throw new NamespaceError("NOT_FOUND", `模型不存在: ${name}`);
      record(
        "model.move",
        `移动模型 ${name} 的文件 → ${toFolder}（${targets.size} 个文件` +
          (sharedModels.length > 0
            ? `，同步更新 ${new Set(sharedModels).size} 个共享引用模型`
            : "") +
          "）",
      );
      return updated;
    },
  };
}
