import type Database from "better-sqlite3";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { basename, join } from "node:path";
import { FileMoveError, moveFiles, type RefUpdate, type RefUpdateField } from "./fileMove";
import { buildRefMap } from "./filesApi";
import { resolveModelFiles, scanTree } from "./fsScanner";
import { createModelRepo, type StoredModel } from "./repo/models";
import type { RuntimeService } from "./runtime";

/**
 * 命名空间管理 + 模型移动空间服务层（M1 Task 12，设计 §5.4）
 *
 * 结构取舍：repo 层（repo/models.ts）只做纯 DB 原语（renameNamespace /
 * deleteNamespace / listNamespacesWithMeta，事务包在 repo 内）；本服务层
 * 负责跨资源编排——repo + 磁盘 mv（host 视角）+ 运行中守卫（runtime）+
 * events，风格对齐 filesApi.ts（错误码 + Error 子类供 route 映射状态码）。
 * 运行中守卫依赖 runtime.getRuntimeStatus()（适配器接口是 async），故
 * renameNamespace / moveModel 为 async；纯 DB 操作保持同步。
 *
 * 语义：
 * - 新建 = 仅 DB 行（name 唯一 + `^[a-z0-9][a-z0-9-]*$`，目录惰性创建）
 * - 重命名 = host 侧 mv 目录（目录不存在跳过，新建即改名等场景 DB 仍是
 *   真源）→ repo.renameNamespace（事务）→ events；该空间有运行中模型 →
 *   拒绝。mv 与 DB 不在一个原子域：先守卫后 mv 再提交 DB，mv 失败则 DB
 *   未动（安全侧）；DB 失败时目录已改名属已知边界，重试同参数即可收敛
 * - 删除 = 其下无模型配置才允许，只删 DB 行；磁盘文件/目录留给文件页处理
 *   （两层解耦：先移走/删除配置，再按需清目录）。main 也允许删——用户可
 *   自由管理；main 是导入默认落点，删除后会被重建（repo 每次构造幂等
 *   确保 main 存在的既有不变量，M0 Task 5）
 * - moveModel：默认仅改 namespace 字段（不动物理文件，跨空间引用由
 *   gguf_file 的 ns 段表达）；可选 moveFiles 把 glob 展开的 gguf 组 +
 *   mmproj mv 到目标空间目录（mkdirSync recursive 惰性建目录）并重写
 *   gguf_file / mmproj_file 的 ns 段（glob 形态保留）。物理移动 + 引用重写
 *   经 fileMove.moveFiles 原语的单事务执行（设计 §2.1/§2.6）：不止改发起
 *   移动的模型自己，还会经 buildRefMap 查出全部共享同一物理文件的模型一并
 *   重写，修复"共享方被静默留在旧路径"的缺陷；共享方中有运行中模型时整个
 *   移动按 LOCKED 拒绝（不能让运行中容器的配置在脚下被改）
 *
 * 两个 models 根分开传入（对齐 runtime.ts 的约定）：panelRoot 用于
 * resolveModelFiles / scanTree（面板视角 fs），hostRoot 用于 mv（宿主视角
 * 落盘）。测试环境两根合一同一路径即可；生产差异由 pathMaps 换算吸收。
 */

/** 与 repo/models.ts / core/schemas.ts 同规则（后者未导出，此处内联校验入参） */
const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** 业务错误码（route 据此映射 HTTP 状态码，见各 route 的 errorResponse） */
export type NamespaceErrorCode =
  | "INVALID_NAME" // 名字非法（400）
  | "NOT_FOUND" // 命名空间 / 模型不存在（404）
  | "DUPLICATE" // 重名（409）
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
  /** 该空间目录下全部文件字节数（目录未创建为 0） */
  bytes: number;
}

/** moveModel 选项 */
export interface MoveModelOptions {
  /** 同时移动物理文件（glob 组全移 + 重写相对路径）；默认 false 仅改分组 */
  moveFiles?: boolean;
}

/** 命名空间服务：面板对"命名空间 CRUD + 模型换空间"的全部依赖收敛在此 */
export interface NamespaceService {
  createNamespace(name: string): void;
  /** 列表视图：DB 元数据 + 模型数 + 磁盘占用（scanTree panel 根，同步） */
  listOverview(): NamespaceOverview[];
  renameNamespace(from: string, to: string): Promise<void>;
  deleteNamespace(name: string): void;
  /** 模型移动空间：返回移动后的模型行 */
  moveModel(name: string, to: string, options?: MoveModelOptions): Promise<StoredModel>;
}

export function createNamespaceService(
  db: Database.Database,
  runtime: RuntimeService,
  roots: { panelRoot: string; hostRoot: string },
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
        `命名空间非法（仅小写字母数字与连字符）: ${name}`,
      );
    }
  }

  /** 当前运行模型名（无则 null） */
  async function currentRunning(): Promise<string | null> {
    return (await runtime.getRuntimeStatus()).running?.model ?? null;
  }

  /** 把配置路径的 ns 段换成 to（glob 形态保留）：
   * `main/x.gguf` → `to/x.gguf`；无目录段的 `x.gguf` → `to/x.gguf` */
  function retarget(rel: string, to: string): string {
    const slash = rel.indexOf("/");
    return slash === -1 ? `${to}/${rel}` : `${to}/${rel.slice(slash + 1)}`;
  }

  /**
   * 展开 moveModel(moveFiles:true) 待移动的物理文件相对路径集合：gguf glob
   * 组 + mmproj（若配置）。零命中（文件缺失）返回空集，不视为错误——重写
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
      const bytesByNs = new Map(
        scanTree(roots.panelRoot).map(
          (n) => [n.folder, n.files.reduce((sum, f) => sum + f.size, 0)] as const,
        ),
      );
      return repo.listNamespacesWithMeta().map((meta) => ({
        ...meta,
        bytes: bytesByNs.get(meta.name) ?? 0,
      }));
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

      // 运行中守卫：该空间任一模型在跑即拒绝（容器正占用该目录的文件）
      const running = await currentRunning();
      if (running !== null && repo.listModels(from).some((m) => m.name === running)) {
        throw new NamespaceError(
          "RUNNING",
          `命名空间 ${from} 下有运行中模型 ${running}，禁止重命名（请先停止）`,
        );
      }

      // host 侧 mv 目录：目录不存在跳过不抛（DB 是真源，目录惰性创建）
      const fromDir = join(roots.hostRoot, from);
      if (existsSync(fromDir)) {
        renameSync(fromDir, join(roots.hostRoot, to));
      }

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

    async moveModel(name, to, options = {}) {
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

      if (options.moveFiles === true) {
        const targets = resolveMoveTargets(model.gguf_file, model.mmproj_file);

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

        // 发起移动的模型自身：namespace + 路径字段一并进事务，不依赖下面的
        // 共享引用扫描是否命中（文件缺失时同样重写——保持既有行为，重写后
        // 的路径指向"应在的位置"）
        addRefUpdate(name, "namespace", to);
        addRefUpdate(name, "gguf_file", retarget(model.gguf_file, to));
        if (model.mmproj_file !== undefined) {
          addRefUpdate(name, "mmproj_file", retarget(model.mmproj_file, to));
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
            addRefUpdate(ref.modelName, ref.field, retarget(oldValue, to));
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

        if (targets.size > 0) {
          const toDir = join(roots.hostRoot, to);
          if (!existsSync(toDir)) mkdirSync(toDir, { recursive: true });
          const sourceAbs = [...targets].map((rel) => join(roots.hostRoot, rel));
          const targetAbs = [...targets].map((rel) => join(toDir, basename(rel)));

          try {
            moveFiles({ db }, { from: sourceAbs, to: targetAbs, refUpdates });
          } catch (error) {
            if (error instanceof FileMoveError) {
              record(
                "model.move",
                `移动模型 ${name} ${model.namespace} → ${to} 失败：${error.message}`,
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
          `移动模型 ${name} ${model.namespace} → ${to}（同时移动 ${targets.size} 个文件` +
            (sharedModels.length > 0
              ? `，同步更新 ${new Set(sharedModels).size} 个共享引用模型`
              : "") +
            "）",
        );
        return updated;
      }

      const updated = repo.updateModel(name, { namespace: to });
      record("model.move", `移动模型 ${name} ${model.namespace} → ${to}（仅改分组，文件不动）`);
      return updated;
    },
  };
}
