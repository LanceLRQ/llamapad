import type Database from "better-sqlite3";
import path from "node:path";
import { buildArgs } from "../core/args";
import { mergeConfig } from "../core/config";
import { applyArgsOverridePlaceholders } from "../core/images";
import type { DefaultConfig, ModelConfig } from "../core/schemas";
import { buildContainerEnv } from "../lib/gpu-visibility";
import { detectReasoningEffort, isEffortAllowed } from "../lib/reasoning-effort";
import type { ContainerSpec, ContainerStatus, DockerAdapter } from "./adapters/types";
import type { DrainResult } from "./drain";
import { resolveModelFiles } from "./fsScanner";
import { getGgufMeta } from "./ggufMeta";
import { METRIC_IDS } from "./metrics/ids";
import { createModelRepo } from "./repo/models";
import { createRunsRepo, type RunAggregates } from "./runs";

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
 *
 * 运行历史记录（U17）：每次启停在 runs 表落一行（起止时间 / 结束原因 /
 * tok·s 与显存聚合），供监控页历史列表与下次启动前的显存 preflight 使用。
 * GPU 读数与区间聚合经可选 RuntimeDeps 惰性注入——本模块不直接依赖指标采集/
 * 存储实现，deps 缺省时聚合值全部记 null（不影响启停主流程）。悬空 run
 * （面板重启前未正常关闭）在 getRuntimeStatus 内一次性对账，见该函数注释。
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
 *   引导默认，运行时以真实 host 根为准，故不取合并值）。本函数是纯组装，不做
 *   hostModelsRoot 判空——未覆盖 model_volume 时 hostModelsRoot 是否已解析由
 *   唯一的生产调用方 startModel 在拼容器前校验（见其头部注释），避免这里抛错时
 *   前面已经发生的 stop 副作用回退不掉
 * - name / image / 端口 / gpu：mergeConfig(defaults, overrides) 合并结果
 *   （container_name 可被模型覆盖，不写死）
 * - modelMount：容器内模型挂载点，取 merged.docker.model_mount，未设置时兜底
 *   "/models"（§1.2 修复：此前硬编码 /models，与可覆盖的 model_volume 挂载点
 *   一旦不一致就会让 -m 路径在容器内找不到文件）
 * - args：args_override 已设置 → 对它做三个占位符替换（core/images.ts），
 *   整体取代生成参数；否则 buildArgs 产出 ++ extra_args（追加，见 §5.6）。
 *   PANEL_DEBUG_ARGS 存在且 NODE_ENV !== "production" 时再整体替换为
 *   ["sh", "-c", <env 值>]（本地调试钩子，优先级最高，与 args_override 无关）
 * - env：仅用户 docker.env 原样透传（enable_thinking 等模板层开关已改走
 *   args.ts 的 --chat-template-kwargs CLI 参数，不再需要内置 env 注入——
 *   上游把该 env 名改为 LLAMA_ARG_CHAT_TEMPLATE_KWARGS 导致旧名失效，见
 *   args.ts 注释）
 * - entrypoint：透传 merged.docker.entrypoint；未设置时不产出该字段，
 *   docker-options.ts 据此决定是否覆盖镜像自身 entrypoint
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

  const modelMount = merged.docker.model_mount ?? "/models";
  const modelPath = `${modelMount}/${ggufRel}`;
  const mmprojPath = mmprojRel !== undefined ? `${modelMount}/${mmprojRel}` : undefined;

  let args: string[];
  if (merged.docker.args_override !== undefined) {
    args = applyArgsOverridePlaceholders(merged.docker.args_override, {
      modelPath,
      mmprojPath,
      port: merged.docker.container_port,
    });
  } else {
    args = buildArgs({
      server: merged.server,
      modelPath,
      mmprojPath,
      port: merged.docker.container_port,
      // 面板模型名透传给 --alias：llama-server 用它覆盖 /v1/models 的 id 与
      // chat 响应的 model 字段（实测），见 core/args.ts 文件头注释
      alias: model.name,
    });
    if (merged.docker.extra_args !== undefined) {
      args = [...args, ...merged.docker.extra_args];
    }
  }

  const debugScript = process.env.PANEL_DEBUG_ARGS;
  if (debugScript && process.env.NODE_ENV !== "production") {
    args = ["sh", "-c", debugScript];
  }

  // enable_thinking 已改走 args.ts 的 --chat-template-kwargs CLI 参数（上游把
  // 内置 env 名改为 LLAMA_ARG_CHAT_TEMPLATE_KWARGS 导致旧名失效，见 args.ts
  // 注释），此处不再注入模板层 env；用户自定义 docker.env 原样保留。
  //
  // 设备序（CUDA_DEVICE_ORDER）是唯一的内置注入项，理由与优先级见
  // lib/gpu-visibility.ts 的 buildContainerEnv 注释：异构多卡下 ggml 的枚举顺序
  // 与 nvidia-smi 不一致，不注入的话面板显示的「GPU 0」和 llama.cpp 的「CUDA0」
  // 可能不是同一张卡。用户自己写过该键则完全不插手。
  const env = buildContainerEnv(merged.docker.env ?? [], merged.docker.gpu);

  return {
    name: merged.docker.container_name,
    image: merged.docker.image,
    hostPort: merged.docker.host_port,
    containerPort: merged.docker.container_port,
    volume: overrides.docker?.model_volume ?? `${hostModelsRoot}:/models`,
    gpu: merged.docker.gpu,
    labels: { [MANAGED_LABEL]: "true", [MODEL_LABEL]: model.name },
    args,
    env,
    entrypoint: merged.docker.entrypoint,
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
 * 列出**全部**正在运行的托管模型信息（AI 解析的本地候选）。
 * 单模型是硬约束（启停互斥 + 切换是停旧起新），正常只会有一项；
 * 异常态（手工起的带标签容器、残留容器）下如实全列，由调用方决定怎么呈现。
 */
export async function listRunningModelInfos(
  db: Database.Database,
  adapter: DockerAdapter,
): Promise<RunningContainerInfo[]> {
  const running = await listRunningManaged(adapter);
  if (running.length === 0) return [];

  const repo = createModelRepo(db);
  const defaults = repo.getDefaultConfig();
  return running.map((container) => {
    const model = container.labels![MODEL_LABEL];
    const row = repo.getModel(model);
    return {
      container: container.name,
      model,
      hostPort: row ? mergeConfig(defaults, row.overrides ?? {}).docker.host_port : null,
    };
  });
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
  const infos = await listRunningModelInfos(db, adapter);
  return infos[0] ?? null;
}

/** getRuntimeStatus 返回形态 */
export interface RuntimeStatus {
  running: RunningModel | null;
  /** 多个托管容器同时存在（违反单模型约束的异常态）：如实取第一个并标注，不抛错 */
  warning?: "multiple";
}

/** startModel/stopModel/restartModel 的可选排空参数（切换/停止前等在途推理结束） */
export interface RuntimeActionOptions {
  /** 是否在停旧容器前排空；缺省 false，行为与不传第二参完全等价 */
  drain?: boolean;
  /** 排空最长等待时长（毫秒）；未传时由 deps.waitForIdle 的调用方决定默认值 */
  drainTimeoutMs?: number;
}

/**
 * 排空结果（对外可见形态）：在 DrainResult 基础上加一个 "skipped"——
 * 排空被请求但没有真的等待过的落地态：deps.waitForIdle 未注入、待停模型行
 * 已被删除拿不到 hostPort、或压根没有旧容器需要停（冷启动）。三者都照常继续，
 * 只是跳过了排空等待本身。
 *
 * 契约：只要调用方传了 drain:true，返回值就一定带排空结果（哪怕是 skipped），
 * 不传就一定没有——调用方（llamapad-dsh-plugin）据此判定，不必区分"字段缺席"
 * 与"没排空"两种情形。
 */
export interface DrainOutcome {
  drained: boolean;
  reason: "idle" | "timeout" | "unavailable" | "skipped";
}

/** 运行时服务：面板对"启停一个模型容器"的全部依赖收敛在此 */
export interface RuntimeService {
  startModel(name: string, options?: RuntimeActionOptions): Promise<{ id: string; drain?: DrainOutcome }>;
  stopModel(name: string, options?: RuntimeActionOptions): Promise<DrainOutcome | undefined>;
  restartModel(name: string, options?: RuntimeActionOptions): Promise<{ id: string; drain?: DrainOutcome }>;
  getRuntimeStatus(): Promise<RuntimeStatus>;
}

/**
 * 运行历史记录的可选外部依赖（U17）：全部惰性注入（调用时才取值），
 * 不在构造 createRuntimeService 时求值——locators 里 runtime 与
 * metrics collector/store 互相引用，提前求值会成环（U15 的 onAutoStart
 * 回调注入踩过一次，处置方式相同）。测试/mock 场景可整体不传，此时
 * 聚合值全部记 null，不影响启停主流程。
 *
 * waitForIdle 同款惰性注入（本文件不直接 import fetch 相关实现，排空的
 * 网络探测全部在 drain.ts）：未注入时 options.drain=true 也只落 "skipped"，
 * 不阻塞停止主流程。
 */
export interface RuntimeDeps {
  /** 当前整卡显存占用（MiB）；GPU 不可用 → null */
  getGpuMemUsedMib?: () => number | null;
  /** 当前整卡显存总量（MiB）；GPU 不可用 → null */
  getGpuMemTotalMib?: () => number | null;
  /** 区间聚合（run 结束回填用）；缺省则聚合值全部记 null */
  aggregate?: (
    metric: string,
    from: number,
    to: number,
  ) => { max: number; avg: number; count: number } | null;
  /** 排空探测：轮询目标模型的 /slots 直到空闲或超时，见 drain.ts */
  waitForIdle?: (args: { hostPort: number; timeoutMs: number }) => Promise<DrainResult>;
}

/** options.drain=true 但未显式给 drainTimeoutMs 时的默认超时（毫秒）。
 *  三个启停路由的 zod `.default()` 直接复用本常量，四处不各写一份数字。 */
export const DEFAULT_DRAIN_TIMEOUT_MS = 60_000;

/** exclusive() 包装的三个动作名（RuntimeBusyError.runningAction 的取值范围） */
type RuntimeAction = "start" | "stop" | "restart";

const RUNTIME_ACTION_LABEL: Record<RuntimeAction, string> = {
  start: "启动",
  stop: "停止",
  restart: "重启",
};

/**
 * 运行时忙：上一个启停请求尚未结束，本次请求被直接拒绝（真机实测的并发缺陷，
 * 见 exclusive() 头注释）。故意不做排队——排队会让两个可能指向不同模型的
 * 请求依次执行（先起 A 再起 B），语义比直接拒绝更让人困惑；面板本身是
 * 单模型设计，"抢不到就重试"对用户更直观。
 */
export class RuntimeBusyError extends Error {
  constructor(
    readonly runningAction: RuntimeAction,
    readonly runningModel: string,
  ) {
    super(`运行时忙：正在${RUNTIME_ACTION_LABEL[runningAction]}模型 ${runningModel}，请等待当前操作完成后再试`);
    // 继承内建类后修正原型链（modelErrors.ts 同款写法：TS 编译到 ES5 目标时 instanceof 会失效）
    Object.setPrototypeOf(this, RuntimeBusyError.prototype);
  }
}

/**
 * 思考强度不被该模型 chat template 接受：真机复现的缺陷（背景见
 * lib/reasoning-effort.ts 头部文档）——值域外的 reasoning_effort 不会被 zod 挡下
 * （schema 只校验字符串本身，不知道"这个模型的模板认哪些值"），容器会照常启动、
 * /health 照常 200，只有真正发一次推理请求时才从 jinja 里炸出 500，那段错误是
 * llama.cpp 的执行栈，用户完全看不懂。message 直接把允许值域列出来替代它。
 */
export class ReasoningEffortNotAllowedError extends Error {
  constructor(
    readonly value: string,
    readonly allowedLevels: string[],
  ) {
    super(
      `思考强度 "${value}" 不被该模型的 chat template 接受（允许值：${allowedLevels.join("、")}）`,
    );
    Object.setPrototypeOf(this, ReasoningEffortNotAllowedError.prototype);
  }
}

export function createRuntimeService(
  db: Database.Database,
  adapter: DockerAdapter,
  hostModelsRoot: string,
  panelModelsRoot: string,
  deps?: RuntimeDeps,
): RuntimeService {
  const repo = createModelRepo(db);
  const runsRepo = createRunsRepo(db);
  const insertEvent = db.prepare("INSERT INTO events(ts, kind, message) VALUES (?, ?, ?)");

  /** 追加一条事件（ts 毫秒时间戳） */
  function record(kind: string, message: string): void {
    insertEvent.run(Date.now(), kind, message);
  }

  /** run 结束时的聚合值：deps.aggregate 未注入时全部为 null（测试/mock 场景） */
  function computeAggregates(startedAt: number, endedAt: number): RunAggregates {
    const gpu = deps?.aggregate?.(METRIC_IDS.gpuMemUsedMib, startedAt, endedAt) ?? null;
    const tps = deps?.aggregate?.(METRIC_IDS.inferTokensPerSec, startedAt, endedAt) ?? null;
    return {
      peakGpuMemMib: gpu?.max ?? null,
      avgTokensPerSec: tps?.avg ?? null,
      peakTokensPerSec: tps?.max ?? null,
    };
  }

  /**
   * 结束属于 model 的悬空 run（若存在）。不存在悬空 run、或悬空 run 属于
   * 别的模型（理论上不应发生，单模型约束下如实忽略不抛错）则静默跳过。
   */
  function finishRun(model: string, endReason: string): void {
    const open = runsRepo.getOpenRun();
    if (!open || open.model !== model) return;
    const endedAt = Date.now();
    runsRepo.closeRun(open.id, endReason, computeAggregates(open.started_at, endedAt));
  }

  // 迟退检测状态（M4 真机）：上次观察到的运行模型 + 面板容器操作时间戳
  let lastObserved: string | null = null;
  let panelActionAt = 0;
  const notePanelAction = () => {
    panelActionAt = Date.now();
  };

  /** 从 label 推导的运行容器中取出模型名；无 model 标签的托管容器（异常态）退回容器名 */
  function modelOf(container: ContainerStatus): string {
    return container.labels?.[MODEL_LABEL] ?? container.name;
  }

  /**
   * 排空判定（仅 options.drain 为真时执行）：取 model 的 hostPort——路径与
   * getRunningContainerInfo 完全一致：mergeConfig(默认配置, overrides).docker.host_port。
   * 模型行已删（拿不到 hostPort）或 deps.waitForIdle 未注入 → 跳过排空，
   * 直接落 {drained:true, reason:"skipped"}（放行，不阻塞停止）。
   */
  async function drainBeforeStop(
    model: string,
    options: RuntimeActionOptions | undefined,
  ): Promise<DrainOutcome | undefined> {
    if (!options?.drain) return undefined;
    if (!deps?.waitForIdle) return { drained: true, reason: "skipped" };

    const row = repo.getModel(model);
    const hostPort = row
      ? mergeConfig(repo.getDefaultConfig(), row.overrides ?? {}).docker.host_port
      : null;
    if (hostPort === null) return { drained: true, reason: "skipped" };

    const timeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
    return deps.waitForIdle({ hostPort, timeoutMs });
  }

  /**
   * drain 结果转事件文案后缀：仅排空确实发生过（options.drain 为真）才追加，
   * 未请求排空时返回空串——保证不传 drain 时事件文案与现在逐字节一致。
   */
  function drainSuffix(drain: DrainOutcome | undefined): string {
    if (drain === undefined) return "";
    const text: Record<DrainOutcome["reason"], string> = {
      idle: "已空闲",
      timeout: "超时仍在处理请求",
      unavailable: "探测不可用",
      skipped: "跳过",
    };
    return `，排空${text[drain.reason]}`;
  }

  /**
   * 停掉某模型的全部运行容器（按 llamapad.model=<name> 查询，通常 0 或 1 个）。
   * 幂等：无容器时不写事件——events 只记状态变化，重复 stop / 轮询不应刷表。
   * endReason 是喂给 runs.end_reason 的机器可读值，与 reason（事件文案）分开——
   * 不能直接拿中文文案当 end_reason。排空发生在 adapter.stop 之前，结果透传给调用方。
   */
  async function stopByName(
    name: string,
    reason: string,
    endReason: string,
    options?: RuntimeActionOptions,
  ): Promise<DrainOutcome | undefined> {
    const running = await adapter.list({ label: `${MODEL_LABEL}=${name}` });
    // 请求了排空就一定给结果：没有容器可停时循环不执行，落 skipped（见 DrainOutcome 契约）
    let drain: DrainOutcome | undefined = options?.drain
      ? { drained: true, reason: "skipped" }
      : undefined;
    for (const container of running) {
      drain = await drainBeforeStop(name, options);
      notePanelAction();
      await adapter.stop(container.name);
      record(EVENT_STOP, `停止模型 ${name}（${reason}）${drainSuffix(drain)}`);
      finishRun(name, endReason);
    }
    return drain;
  }

  /**
   * 单模型切换前提：停掉当前所有托管容器（正常态至多一个）。
   * 与待启动模型同名 → 重建容器；异名 → 切换。事件按容器逐个记录。
   * 排空发生在 adapter.stop 之前，探测目标是"即将被停掉"的当前模型（非待启动的 nextModel）。
   */
  async function stopManagedBeforeStart(
    nextModel: string,
    options?: RuntimeActionOptions,
  ): Promise<DrainOutcome | undefined> {
    const running = await adapter.list({ label: `${MANAGED_LABEL}=true` });
    // 同 stopByName：冷启动（无旧容器）时也给 skipped，不让 drain 字段忽有忽无
    let drain: DrainOutcome | undefined = options?.drain
      ? { drained: true, reason: "skipped" }
      : undefined;
    for (const container of running) {
      const current = modelOf(container);
      drain = await drainBeforeStop(current, options);
      notePanelAction();
      await adapter.stop(container.name);
      const recreate = current === nextModel;
      const reason = recreate ? "重建容器" : `切换到 ${nextModel}`;
      record(EVENT_STOP, `停止模型 ${current}（${reason}）${drainSuffix(drain)}`);
      finishRun(current, recreate ? "recreated" : "switched");
    }
    return drain;
  }

  /**
   * reasoning_effort 前置校验（真机复现的缺陷，见 ReasoningEffortNotAllowedError
   * 注释）：抽成独立函数供 startModel（清场前）与 restartModel（stopByName 之前）
   * 两处复用——「改配置→重启生效」是用户最常触发的操作，restart 若只靠内部调用
   * startModel 来间接覆盖，校验触发时旧容器早被 stopByName 停掉了，保护在最需要
   * 的场景反而失效（真机实测复现：restart 非法配置 → 422 报对了，但容器已经死了）。
   *
   * gguf 路径在这里自行重新解析，不接收调用方已缓存的结果——两个调用点的时机不同
   * （restartModel 在文件缺失校验之前就要调用本函数），自包含更简单。解析拿不到
   * 文件时静默放行，不在这里抢先报一个思考强度的错：模型文件缺失应由 startModel
   * 内既有的校验去报，那个错误信息更贴切，这里抢跑会改变 restart 现有的错误语义。
   */
  async function assertReasoningEffortAllowed(model: ModelConfig): Promise<void> {
    const effort = mergeConfig(repo.getDefaultConfig(), model.overrides ?? {}).server.reasoning_effort;
    if (effort === "inherit") return;

    const gguf = resolveModelFiles(panelModelsRoot, model.gguf_file);
    if (gguf.missing || gguf.files.length === 0) return;

    const meta = await getGgufMeta(db, path.join(panelModelsRoot, gguf.files[0].rel));
    const support = detectReasoningEffort(meta?.chatTemplate ?? null);
    if (!isEffortAllowed(effort, support)) {
      throw new ReasoningEffortNotAllowedError(effort, support.levels ?? []);
    }
  }

  async function startModel(
    name: string,
    options?: RuntimeActionOptions,
  ): Promise<{ id: string; drain?: DrainOutcome }> {
    const model = repo.getModel(name);
    if (!model) throw new Error(`模型不存在: ${name}`);

    // model_volume 覆盖存在时 buildContainerSpec 用不上 hostModelsRoot（见其头注释），
    // 该分支不该被这条校验误伤；未覆盖时才真正会拼出 `${hostModelsRoot}:/models`，
    // hostModelsRoot 为空会拼成 ":/models" 让 docker 抛一句晦涩的 invalid volume
    // specification——必须在这里挡且必须挡在 stopManagedBeforeStart 之前：
    // 校验失败不能有副作用，不能因为路径没配就先把正在跑的模型停了
    if (model.overrides?.docker?.model_volume === undefined && hostModelsRoot.trim() === "") {
      throw new Error(
        "models 宿主机路径未解析：请设置环境变量 PANEL_MODELS_HOST，或在 panel.yaml 配置 paths.models.host，或确认面板容器已挂载模型目录",
      );
    }

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

    // reasoning_effort 前置校验：与上面两处校验同理，必须挡在 stopManagedBeforeStart
    // 之前——配置非法就该直接拒绝启动，不能先把用户正在跑的模型停了再报错。
    // 函数体共享给 restartModel（见 assertReasoningEffortAllowed 头部注释）。
    await assertReasoningEffortAllowed(model);

    // 单模型约束：先清场（同名重建 / 异名切换），再起新容器
    const drain = await stopManagedBeforeStart(name, options);

    // baseline 必须在旧容器已停之后采样（不能在函数开头就采）：切换模型时
    // stopManagedBeforeStart 才刚把上一个模型的容器停掉、显存释放；若提前采样，
    // 上一个模型占的显存会被算进新 run 的 baseline，导致净增量被严重低估甚至为负。
    const baselineMib = deps?.getGpuMemUsedMib?.() ?? null;
    const totalMib = deps?.getGpuMemTotalMib?.() ?? null;

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
    runsRepo.openRun(name, baselineMib, totalMib);
    lastObserved = name; // 启动成功即视为已观察到运行（迟退检测基线，无需等首次查询）
    return drain !== undefined ? { id: started.id, drain } : { id: started.id };
  }

  async function stopModel(
    name: string,
    options?: RuntimeActionOptions,
  ): Promise<DrainOutcome | undefined> {
    return stopByName(name, "手动停止", "stopped", options);
  }

  async function restartModel(
    name: string,
    options?: RuntimeActionOptions,
  ): Promise<{ id: string; drain?: DrainOutcome }> {
    // reasoning_effort 前置校验必须在 stopByName 之前：restart 内部虽然也调用了
    // startModel，但那次调用发生在旧容器已经被停掉之后——校验挡在那里等于没挡
    // （真机实测复现：restart 非法配置确实报了 422，但容器已经被停掉）。
    // 模型不存在时不在这里报错，交给下面 startModel 内既有的判定，那个错误信息更准确。
    const model = repo.getModel(name);
    if (model) await assertReasoningEffortAllowed(model);

    // 重启 = 停后即起同一模型，语义等价"同名重建"，复用同一 end_reason；
    // 排空结果取自本次 stop（start 阶段此时已无旧容器可停，不会重复排空）
    const drain = await stopByName(name, "重启", "recreated", options);
    const started = await startModel(name, options);
    return drain !== undefined ? { id: started.id, drain } : started;
  }

  // 悬空 run 对账（面板重启）：只做一次，见 getRuntimeStatus 内注释
  let reconciled = false;

  async function getRuntimeStatus(): Promise<RuntimeStatus> {
    const running = await listRunningManaged(adapter);

    // 迟退检测（M4 真机）：启动成功后进程崩溃（容器消失），attach 摘要只覆盖
    // 瞬退（10s 窗口内），迟退在此补事件。面板主动 stop/切换/recreate 的 null
    // 迁移经 panelActionAt 豁免（10s 窗口），只记真正的异常消失。
    const observed = running.length > 0 ? running[0].labels![MODEL_LABEL] : null;
    if (
      lastObserved !== null &&
      observed === null &&
      Date.now() - panelActionAt > 10_000
    ) {
      record("model.exit", `模型 ${lastObserved} 的容器已退出（非面板操作，疑似异常）`);
      finishRun(lastObserved, "exited");
    }
    lastObserved = observed;

    // 悬空 run 对账（U17，面板重启场景）：面板重启后进程内存态清零，但上次的
    // run 可能还是 ended_at IS NULL（llama-server 是兄弟容器，面板停了不影响它
    // 继续跑）。本函数本就查运行容器、又被采集器每轮与页面轮询调用，无需新增
    // 启动钩子；用 reconciled 标志保证只对账一次，避免每次轮询都多查一次 db。
    if (!reconciled) {
      reconciled = true;
      const open = runsRepo.getOpenRun();
      if (open !== null && open.model !== observed) {
        // 悬空 run 的模型不等于当前运行容器 → 面板停机期间该运行已经结束
        runsRepo.closeRun(open.id, "panel_restart", computeAggregates(open.started_at, Date.now()));
      }
      // else：悬空 run 与当前运行容器同名 → 面板重启期间容器一直在跑，
      // 这是一次连续的运行，沿用不关闭。
    }

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

  // 进程内互斥（真机实测的并发缺陷）：第二个启停请求进来时，stopManagedBeforeStart
  // 会把所有托管容器都停掉——包括第一个请求刚创建、还在加载模型的那个，SIGKILL
  // 令其 exit 137，第一个请求的启动轮询随后误报「容器启动即退出」。本面板是单进程
  // Next.js standalone（不支持多实例），进程内锁足够，无需跨进程/分布式方案。
  //
  // 只包在这里（return 的服务对象）而不是包进 startModel/stopModel/restartModel
  // 函数体内：restartModel 内部是直接调本地闭包里的 startModel / stopByName
  // （见上方 475-482 行），走的是未包装的本地函数，天然不会自锁；若改成在函数体内
  // 加锁，restartModel 会在调用内部 startModel 时把自己已经持有的锁当成"被占用"
  // 而拒绝自己。
  //
  // getRuntimeStatus 绝对不包在互斥里：它是只读查询，且启动弹窗与 Chat 加载态
  // 都在启动期间每 2s 轮询它——锁住它会让整个进度界面在锁定期间瞎掉。
  let inFlight: { action: RuntimeAction; model: string } | null = null;

  function exclusive<A extends unknown[], R>(
    action: RuntimeAction,
    fn: (name: string, ...rest: A) => Promise<R>,
  ): (name: string, ...rest: A) => Promise<R> {
    return async (name, ...rest) => {
      if (inFlight !== null) throw new RuntimeBusyError(inFlight.action, inFlight.model);
      inFlight = { action, model: name };
      try {
        return await fn(name, ...rest);
      } finally {
        // 无论成败都必须释放：漏写这一步会让面板永久锁死（一次失败的启动就再也起不来任何模型）
        inFlight = null;
      }
    };
  }

  return {
    startModel: exclusive("start", startModel),
    stopModel: exclusive("stop", stopModel),
    restartModel: exclusive("restart", restartModel),
    getRuntimeStatus,
  };
}
