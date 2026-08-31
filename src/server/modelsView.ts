import type Database from "better-sqlite3";
import { basename } from "node:path";
import { mergeConfig } from "../core/config";
import { detectQuant } from "../core/files";
import { resolveModelFiles } from "./fsScanner";
import { probeReady } from "./readiness";
import { createModelRepo } from "./repo/models";
import type { RuntimeService } from "./runtime";

/**
 * 模型列表装配层（M1 Task 7）
 *
 * 把三路数据合并成列表页 / GET /api/v1/models 需要的一行一份的视图：
 * - DB 模型行（repo.listModels）
 * - 运行状态（runtime.getRuntimeStatus，从容器 label 推导"谁是当前运行模型"）
 * - 文件扫描（resolveModelFiles 于 panel 根，missing 时容错不抛错——
 *   panel 根本身不存在（ENOENT）也按 missing 处理）
 *
 * 状态优先级（与 startModel 的启动校验一致）：
 *   running（容器在跑，优先于文件检查）＞ missing-file（gguf 缺）
 *   ＞ missing-mmproj（gguf 在但配置的 mmproj 缺）＞ ready
 *
 * sizeBytes 只计 gguf（含全部分片）：mmproj 通常只有几百 MB 且可选，
 * 列表语义是"这个模型占多少盘"以主文件为准；fileCount 即分片数
 * （glob 零命中 / 精确缺失时为 0，UI 显示 "—"）。
 */

/** 列表行状态（优先级从高到低：running > missing-file > missing-mmproj > ready） */
export type ModelStatus = "running" | "missing-file" | "missing-mmproj" | "ready";

/** 列表页 / API 输出的单模型视图（纯 JSON 可序列化，可直接作 RSC props） */
export interface ModelView {
  name: string;
  displayName: string;
  namespace: string;
  /** 相对 panel models 根的 gguf 路径（可能是分片 glob） */
  ggufFile: string;
  /** 配置了 mmproj 时为其相对路径，否则 null */
  mmprojFile: string | null;
  status: ModelStatus;
  /** 文件名识别出的量化标签（大写归一）；识别不到为 null */
  quant: string | null;
  /** gguf（含分片）总字节数；缺失时 0 */
  sizeBytes: number;
  /** gguf 分片数（>1 时 UI 显示 "×N"）；缺失时 0 */
  fileCount: number;
  /** mergeConfig(默认配置, 模型 overrides) 后的 docker.host_port */
  hostPort: number;
  /** 创建时间（ISO 8601），供列表按时间排序——固定取 created_at 而非
   * updated_at：后者会因为改一次参数就跳到最前，作为排序键太跳 */
  createdAt: string;
  /** 配置漂移（UX P0 Task 7）：本模型运行中且启动后配置又被保存过——
   * 运行容器参数不会热更新，UI 据此提示"重启后生效"防"改了以为生效" */
  configStale: boolean;
}

/**
 * 装配全部模型的列表视图（按 name 排序，来自 repo.listModels）。
 *
 * @param db            面板库（模型行 + 默认配置）
 * @param runtime       运行时服务（当前运行模型从容器 label 推导）
 * @param panelModelsRoot panel 视角的 models 根（文件存在性检查；不存在时全量 missing）
 */
export async function decorateModels(
  db: Database.Database,
  runtime: RuntimeService,
  panelModelsRoot: string,
): Promise<ModelView[]> {
  const repo = createModelRepo(db);
  const defaults = repo.getDefaultConfig();
  const running = (await runtime.getRuntimeStatus()).running;
  const runningModel = running?.model ?? null;
  const runningStartedMs = running?.startedAt ? Date.parse(running.startedAt) : null;

  return repo.listModels().map((model) => {
    // panel 根 / 精确路径 / glob 的 ENOENT 与零命中都落在 missing 容错分支，不抛错
    const gguf = resolveModelFiles(panelModelsRoot, model.gguf_file);
    const mmproj =
      model.mmproj_file === undefined
        ? undefined
        : resolveModelFiles(panelModelsRoot, model.mmproj_file);
    const mmprojMissing = mmproj !== undefined && (mmproj.missing || mmproj.files.length === 0);

    const status: ModelStatus =
      model.name === runningModel
        ? "running"
        : gguf.missing || gguf.files.length === 0
          ? "missing-file"
          : mmprojMissing
            ? "missing-mmproj"
            : "ready";

    const merged = mergeConfig(defaults, model.overrides ?? {});
    return {
      name: model.name,
      displayName: model.display_name,
      namespace: model.namespace,
      ggufFile: model.gguf_file,
      mmprojFile: model.mmproj_file ?? null,
      status,
      quant: detectQuant(basename(gguf.files[0]?.rel ?? model.gguf_file)),
      sizeBytes: gguf.files.reduce((sum, f) => sum + f.size, 0),
      fileCount: gguf.files.length,
      hostPort: merged.docker.host_port,
      createdAt: model.created_at,
      configStale:
        model.name === runningModel &&
        runningStartedMs !== null &&
        Date.parse(model.updated_at) > runningStartedMs,
    };
  });
}

// ---------- 运行状态装饰（M1 Task 9，概览页 / 顶栏 chip / GET /api/v1/runtime/status 共用） ----------

/** 运行中模型的展示视图（displayName/hostPort 来自 repo 模型行 + mergeConfig） */
export interface RunningModelView {
  /** 模型名（llamapad.model 标签值） */
  model: string;
  /** 展示名；模型行已删时退回模型名 */
  displayName: string;
  /** 容器名 */
  container: string;
  /** 容器启动时间（ISO 8601）；适配器拿不到时为 null */
  startedAt: string | null;
  /** mergeConfig 后的 docker.host_port；模型行已删（无法合并）时为 null */
  hostPort: number | null;
  /** 配置漂移：启动后模型行又被保存过（updated_at > startedAt）；行删/时间缺时 false */
  configStale: boolean;
  /** llama-server 是否已开始监听（/health 200）。容器在跑 ≠ 模型可用：27B 实测容器启动后还要 34s 才 listening */
  ready: boolean;
}

/** decorateRuntimeStatus 返回形态（warning 语义同 runtime.RuntimeStatus） */
export interface RuntimeStatusView {
  running: RunningModelView | null;
  warning?: "multiple";
}

/**
 * 装饰运行状态：把容器 label 推导出的裸运行快照补上展示字段——
 * displayName 取 repo 模型行、hostPort 取 mergeConfig(默认, overrides)，
 * 两者的查询都容错"模型行已被删除"（容器还在跑但配置没了）：
 * displayName 退回模型名、hostPort 置 null。
 *
 * ready（真机缺陷修复）：容器在跑不代表 llama-server 已监听，须另外探测
 * （见 readiness.ts 头注释）。probe 参数缺省用应用侧单例 probeReady，
 * 测试注入假探测；hostPort 为 null（模型行已删，无目标端口）时直接判 false，
 * 不发起探测——没有端口可打。
 */
export async function decorateRuntimeStatus(
  db: Database.Database,
  runtime: RuntimeService,
  probe: (hostPort: number) => Promise<boolean> = probeReady,
): Promise<RuntimeStatusView> {
  const status = await runtime.getRuntimeStatus();
  if (!status.running) return { running: null };

  const repo = createModelRepo(db);
  const row = repo.getModel(status.running.model);
  const startedMs = status.running.startedAt ? Date.parse(status.running.startedAt) : null;
  const hostPort = row
    ? mergeConfig(repo.getDefaultConfig(), row.overrides ?? {}).docker.host_port
    : null;
  return {
    running: {
      model: status.running.model,
      displayName: row?.display_name ?? status.running.model,
      container: status.running.container,
      startedAt: status.running.startedAt,
      hostPort,
      configStale:
        row !== null && startedMs !== null && Date.parse(row.updated_at) > startedMs,
      ready: hostPort !== null ? await probe(hostPort) : false,
    },
    warning: status.warning,
  };
}
