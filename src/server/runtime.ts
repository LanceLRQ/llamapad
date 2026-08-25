import type Database from "better-sqlite3";
import { buildArgs } from "../core/args";
import { mergeConfig } from "../core/config";
import type { DefaultConfig, ModelConfig } from "../core/schemas";
import type { ContainerSpec, ContainerStatus, DockerAdapter } from "./adapters/types";
import { resolveModelFiles } from "./fsScanner";
import { createModelRepo } from "./repo/models";

/**
 * 运行时服务层（M1 Task 6）：单模型启停 / 切换 / 重启 + 事件记录
 *
 * 核心不变量：同一时刻至多一个本面板管理的模型容器在运行（单模型约束）。
 *
 * "谁是当前运行模型"不落内存状态，一律走容器 label 查询
 * （llamapad.managed=true / llamapad.model=<name>）——面板重启 / 崩溃后自愈，
 * 也不写死唯一容器名（容器名来自模型合并配置 docker.container_name，模型可
 * 各自覆盖，为 §14 多模型预留）。
 *
 * 两个 models 根分开传入：host 根用于 docker bind（volume 左侧），panel 根
 * 用于文件存在性检查（生产中 panel 未必以宿主机视角看待同一棵树；测试传同一目录）。
 */

/** 托管容器标签：本面板管理的容器 */
const MANAGED_LABEL = "llamapad.managed";
/** 托管容器上"属于哪个模型"的标签（值为 model.name） */
const MODEL_LABEL = "llamapad.model";

/** 事件 kind：模型启动成功 */
const EVENT_START = "model.start";
/** 事件 kind：模型容器停止（message 标注原因：手动 / 重启 / 重建 / 切换） */
const EVENT_STOP = "model.stop";
/** 事件 kind：模型启动失败（message 含失败原因摘要） */
const EVENT_START_FAILED = "model.start_failed";

/**
 * 已解析的模型文件相对路径（相对 models 根，"ns/文件名"）。
 * gguf 可能为分片 glob，启动前由 resolveModelFiles 解析出首个分片传入；
 * 直接调用 buildContainerSpec 不传时按"配置路径即精确路径"处理（纯组装，无 fs）。
 */
export interface ResolvedModelPaths {
  /** gguf 首个分片的相对路径（分片场景 llama-server 只需传第一个，其余按命名约定自动发现） */
  ggufRel: string;
  /** mmproj 相对路径；模型未配置 mmproj 时为 undefined */
  mmprojRel?: string;
}

/**
 * 组装单个模型的 ContainerSpec（纯函数，无 fs / 无 db）。
 *
 * - volume：模型 overrides.docker.model_volume 覆盖优先；否则由 host 侧 models 根
 *   拼成 `${hostModelsRoot}:/models`（default.docker.model_volume 是宿主机视角的
 *   引导默认，运行时以真实 host 根为准，故不取合并值）
 * - name / image / 端口 / gpu：mergeConfig(defaults, overrides) 合并结果
 *   （container_name 可被模型覆盖，不写死）
 * - args：buildArgs 产出，modelPath/mmprojPath 以容器内 /models 前缀映射；
 *   PANEL_DEBUG_ARGS 存在且 NODE_ENV !== "production" 时整体替换为
 *   ["sh", "-c", <env 值>]（本地调试钩子：让容器跑任意命令而非 llama-server）
 */
export function buildContainerSpec(
  model: ModelConfig,
  defaults: DefaultConfig,
  hostModelsRoot: string,
  resolved?: ResolvedModelPaths,
): ContainerSpec {
  const overrides = model.overrides ?? {};
  const merged = mergeConfig(defaults, overrides);

  const ggufRel = resolved?.ggufRel ?? model.gguf_file;
  const mmprojRel =
    model.mmproj_file !== undefined ? (resolved?.mmprojRel ?? model.mmproj_file) : undefined;

  let args = buildArgs({
    server: merged.server,
    modelPath: `/models/${ggufRel}`,
    mmprojPath: mmprojRel !== undefined ? `/models/${mmprojRel}` : undefined,
    port: merged.docker.container_port,
  });

  const debugScript = process.env.PANEL_DEBUG_ARGS;
  if (debugScript && process.env.NODE_ENV !== "production") {
    args = ["sh", "-c", debugScript];
  }

  return {
    name: merged.docker.container_name,
    image: merged.docker.image,
    hostPort: merged.docker.host_port,
    containerPort: merged.docker.container_port,
    volume: overrides.docker?.model_volume ?? `${hostModelsRoot}:/models`,
    gpu: merged.docker.gpu,
    labels: { [MANAGED_LABEL]: "true", [MODEL_LABEL]: model.name },
    args,
  };
}

/** 当前运行模型快照（从容器 label 推导，非内存状态） */
export interface RunningModel {
  /** 模型名（llamapad.model 标签值） */
  model: string;
  /** 容器名 */
  container: string;
  /** 容器启动时间（ISO 8601）；适配器拿不到时为 null */
  startedAt: string | null;
}

/**
 * 指标采集用的运行信息（M3 Task 2）：调度器每轮 tick 只查一次，
 * dockerStats 采集器吃 container、health 采集器吃 hostPort。
 */
export interface RunningContainerInfo {
  /** 容器名（docker stats 查询目标） */
  container: string;
  /** 模型名（llamapad.model 标签值） */
  model: string;
  /** mergeConfig(默认配置, 模型 overrides) 后的 docker.host_port；
   *  模型行已删（容器还在跑但配置没了）时为 null → health 采集跳过 */
  hostPort: number | null;
}

/**
 * 查询运行中的托管容器（带 llamapad.model 标签者）。
 * getRuntimeStatus 与 getRunningContainerInfo 共用的 label 判定底座。
 */
async function listRunningManaged(adapter: DockerAdapter): Promise<ContainerStatus[]> {
  const managed = await adapter.list({ label: `${MANAGED_LABEL}=true` });
  return managed.filter((c) => c.labels?.[MODEL_LABEL] !== undefined);
}

/**
 * 当前运行容器的采集信息（M3 Task 2）。与 getRuntimeStatus 同源（容器 label
 * 推导），再补 hostPort —— 走 mergeConfig(默认, overrides) 的 docker 段，
 * 与 buildContainerSpec / modelsView.decorateRuntimeStatus 同一路径，
 * 取舍见文件头：单模型约束下取第一个命中，容器在跑但模型行已删时
 * hostPort 退化为 null（不抛错，采集侧按"无目标"降级）。
 */
export async function getRunningContainerInfo(
  db: Database.Database,
  adapter: DockerAdapter,
): Promise<RunningContainerInfo | null> {
  const running = await listRunningManaged(adapter);
  const first = running[0];
  if (first === undefined) return null;

  const model = first.labels![MODEL_LABEL];
  const repo = createModelRepo(db);
  const row = repo.getModel(model);
  return {
    container: first.name,
    model,
    hostPort: row ? mergeConfig(repo.getDefaultConfig(), row.overrides ?? {}).docker.host_port : null,
  };
}

/** getRuntimeStatus 返回形态 */
export interface RuntimeStatus {
  running: RunningModel | null;
  /** 多个托管容器同时存在（违反单模型约束的异常态）：如实取第一个并标注，不抛错 */
  warning?: "multiple";
}

/** 运行时服务：面板对"启停一个模型容器"的全部依赖收敛在此 */
export interface RuntimeService {
  startModel(name: string): Promise<{ id: string }>;
  stopModel(name: string): Promise<void>;
  restartModel(name: string): Promise<{ id: string }>;
  getRuntimeStatus(): Promise<RuntimeStatus>;
}

export function createRuntimeService(
  db: Database.Database,
  adapter: DockerAdapter,
  hostModelsRoot: string,
  panelModelsRoot: string,
): RuntimeService {
  const repo = createModelRepo(db);
  const insertEvent = db.prepare("INSERT INTO events(ts, kind, message) VALUES (?, ?, ?)");

  /** 追加一条事件（ts 毫秒时间戳） */
  function record(kind: string, message: string): void {
    insertEvent.run(Date.now(), kind, message);
  }

  /** 从 label 推导的运行容器中取出模型名；无 model 标签的托管容器（异常态）退回容器名 */
  function modelOf(container: ContainerStatus): string {
    return container.labels?.[MODEL_LABEL] ?? container.name;
  }

  /**
   * 停掉某模型的全部运行容器（按 llamapad.model=<name> 查询，通常 0 或 1 个）。
   * 幂等：无容器时不写事件——events 只记状态变化，重复 stop / 轮询不应刷表。
   */
  async function stopByName(name: string, reason: string): Promise<void> {
    const running = await adapter.list({ label: `${MODEL_LABEL}=${name}` });
    for (const container of running) {
      await adapter.stop(container.name);
      record(EVENT_STOP, `停止模型 ${name}（${reason}）`);
    }
  }

  /**
   * 单模型切换前提：停掉当前所有托管容器（正常态至多一个）。
   * 与待启动模型同名 → 重建容器；异名 → 切换。事件按容器逐个记录。
   */
  async function stopManagedBeforeStart(nextModel: string): Promise<void> {
    const running = await adapter.list({ label: `${MANAGED_LABEL}=true` });
    for (const container of running) {
      const current = modelOf(container);
      await adapter.stop(container.name);
      const reason = current === nextModel ? "重建容器" : `切换到 ${nextModel}`;
      record(EVENT_STOP, `停止模型 ${current}（${reason}）`);
    }
  }

  async function startModel(name: string): Promise<{ id: string }> {
    const model = repo.getModel(name);
    if (!model) throw new Error(`模型不存在: ${name}`);

    // 文件检查走 panel 根：gguf / 已配置的 mmproj 任一缺失即拒绝启动（不触碰现有容器）
    const gguf = resolveModelFiles(panelModelsRoot, model.gguf_file);
    if (gguf.missing || gguf.files.length === 0) {
      throw new Error(`模型文件缺失: ${model.gguf_file}`);
    }
    const resolved: ResolvedModelPaths = { ggufRel: gguf.files[0].rel };
    if (model.mmproj_file !== undefined) {
      const mmproj = resolveModelFiles(panelModelsRoot, model.mmproj_file);
      if (mmproj.missing || mmproj.files.length === 0) {
        throw new Error(`模型文件缺失: ${model.mmproj_file}`);
      }
      resolved.mmprojRel = mmproj.files[0].rel;
    }

    // 单模型约束：先清场（同名重建 / 异名切换），再起新容器
    await stopManagedBeforeStart(name);

    const spec = buildContainerSpec(model, repo.getDefaultConfig(), hostModelsRoot, resolved);
    let started: { id: string };
    try {
      started = await adapter.start(spec);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      record(EVENT_START_FAILED, `启动模型 ${name} 失败: ${reason}`);
      throw error;
    }
    record(EVENT_START, `启动模型 ${name}（容器 ${spec.name}）`);
    return started;
  }

  async function stopModel(name: string): Promise<void> {
    await stopByName(name, "手动停止");
  }

  async function restartModel(name: string): Promise<{ id: string }> {
    await stopByName(name, "重启");
    return startModel(name);
  }

  async function getRuntimeStatus(): Promise<RuntimeStatus> {
    const running = await listRunningManaged(adapter);
    if (running.length === 0) return { running: null };

    const first = running[0];
    const status: RuntimeStatus = {
      running: {
        model: first.labels![MODEL_LABEL],
        container: first.name,
        startedAt: first.startedAt,
      },
    };
    if (running.length > 1) status.warning = "multiple";
    return status;
  }

  return { startModel, stopModel, restartModel, getRuntimeStatus };
}
