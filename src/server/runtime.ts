import type Database from "better-sqlite3";
import path from "node:path";
import { buildArgs } from "../core/args";
import { mergeConfig } from "../core/config";
import { applyArgsOverridePlaceholders } from "../core/images";
import type { DefaultConfig, DockerConfig, ModelConfig } from "../core/schemas";
import { resolveDefaultModel, sortByStartedAt } from "../lib/default-model";
import { buildContainerEnv } from "../lib/gpu-visibility";
import { resolveMtpKind } from "../lib/mtp-kind";
import { allocateContainerSlot, isPortBindError, type ContainerSlot } from "../lib/port-allocation";
import { detectReasoningEffort, shouldBlockEffortSave } from "../lib/reasoning-effort";
import type { ContainerSpec, ContainerStatus, DockerAdapter } from "./adapters/types";
import type { DrainResult } from "./drain";
import { resolveModelFiles } from "./fsScanner";
import { getGgufMeta } from "./ggufMeta";
import { METRIC_IDS } from "./metrics/ids";
import { createModelRepo, type ModelRepo } from "./repo/models";
import { createRunsRepo, type RunAggregates } from "./runs";

/**
 * 运行时服务层（M1 Task 6）：模型启停 / 重启 + 事件记录
 *
 * 多模型并行（2026-09-16 起）：启动一个模型不再停止别的模型，同一模型重复启动
 * 仍是重建容器。容器名与宿主机端口在启动前分配（lib/port-allocation.ts），与运行中
 * 的其他模型冲突、或宿主机端口已被占用时自动顺延；实际端口写进 llamapad.host_port
 * 标签，读取一律以标签为准。
 *
 * "谁在运行"不落内存状态，一律走容器 label 查询
 * （llamapad.managed=true / llamapad.model=<name>）——面板重启 / 崩溃后自愈。
 * 进程内只有三份短期状态：端口/容器名占位表（slots，防并发启动撞车）、按模型分桶的
 * 启停互斥锁（inFlight）、迟退检测的观察集合。
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
/** 托管容器上"实际发布到宿主机的端口"标签（值为十进制字符串）。
 *  多模型并行后端口会被自动顺延，运行中模型的端口不能再从配置反推，以这个标签为准 */
const HOST_PORT_LABEL = "llamapad.host_port";

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
  /** draft/MTP 加速权重相对路径；模型未配置 draft_file 时为 undefined */
  draftRel?: string;
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
 * - slot（多模型并行）：runtime 分配好的容器名与宿主机端口，传了就取代合并配置里的
 *   container_name / host_port；实际端口同时写进 llamapad.host_port 标签
 * - modelMount：容器内模型挂载点，取 merged.docker.model_mount，未设置时兜底
 *   "/models"（§1.2 修复：此前硬编码 /models，与可覆盖的 model_volume 挂载点
 *   一旦不一致就会让 -m 路径在容器内找不到文件）
 * - args：args_override 已设置 → 对它做三个占位符替换（core/images.ts），
 *   整体取代生成参数；否则 buildArgs 产出 ++ extra_args（追加，见 §5.6）。
 *   PANEL_DEBUG_ARGS 存在且 NODE_ENV !== "production" 时再整体替换为
 *   ["sh", "-c", <env 值>]（本地调试钩子，优先级最高，与 args_override 无关）
 * - env：用户 docker.env 原样透传 + 面板默认注入设备序（CUDA_DEVICE_ORDER，
 *   用户写了同名键则不插手，理由见下方 buildContainerEnv 调用处注释）；
 *   enable_thinking 等模板层开关已改走 args.ts 的 --chat-template-kwargs
 *   CLI 参数（上游把该 env 名改为 LLAMA_ARG_CHAT_TEMPLATE_KWARGS 导致旧名
 *   失效，见 args.ts 注释），不再需要为它单独注入 env
 * - entrypoint：透传 merged.docker.entrypoint；未设置时不产出该字段，
 *   docker-options.ts 据此决定是否覆盖镜像自身 entrypoint
 */
export function buildContainerSpec(
  model: ModelConfig,
  defaults: DefaultConfig,
  hostModelsRoot: string,
  resolved?: ResolvedModelPaths,
  slot?: ContainerSlot,
): ContainerSpec {
  const overrides = model.overrides ?? {};
  const merged = mergeConfig(defaults, overrides);

  const ggufRel = resolved?.ggufRel ?? model.gguf_file;
  const mmprojRel =
    model.mmproj_file !== undefined ? (resolved?.mmprojRel ?? model.mmproj_file) : undefined;
  const draftRel = model.draft_file !== undefined ? (resolved?.draftRel ?? model.draft_file) : undefined;

  const modelMount = merged.docker.model_mount ?? "/models";
  const modelPath = `${modelMount}/${ggufRel}`;
  const mmprojPath = mmprojRel !== undefined ? `${modelMount}/${mmprojRel}` : undefined;
  const draftPath = draftRel !== undefined ? `${modelMount}/${draftRel}` : undefined;

  let args: string[];
  if (merged.docker.args_override !== undefined) {
    args = applyArgsOverridePlaceholders(merged.docker.args_override, {
      modelPath,
      mmprojPath,
      draftPath,
      port: merged.docker.container_port,
    });
  } else {
    args = buildArgs({
      server: merged.server,
      modelPath,
      mmprojPath,
      draftPath,
      port: merged.docker.container_port,
      // 面板模型名透传给 --alias：llama-server 用它覆盖 /v1/models 的 id 与
      // chat 响应的 model 字段（实测），见 core/args.ts 文件头注释
      alias: model.name,
      // main_gpu 存的是宿主机编号（语义变更，见 core/schemas.ts），buildArgs 内部
      // 靠这个字段把它翻译成容器内编号，见 core/args.ts 的 BuildArgsInput.gpu 注释
      gpu: merged.docker.gpu,
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

  const hostPort = slot?.hostPort ?? merged.docker.host_port;
  return {
    name: slot?.name ?? merged.docker.container_name,
    image: merged.docker.image,
    hostPort,
    containerPort: merged.docker.container_port,
    volume: overrides.docker?.model_volume ?? `${hostModelsRoot}:/models`,
    gpu: merged.docker.gpu,
    labels: { [MANAGED_LABEL]: "true", [MODEL_LABEL]: model.name, [HOST_PORT_LABEL]: String(hostPort) },
    args,
    env,
    entrypoint: merged.docker.entrypoint,
  };
}

/** 运行中模型快照（从容器 label 推导，非内存状态） */
export interface RunningModel {
  /** 模型名（llamapad.model 标签值） */
  model: string;
  /** 容器名 */
  container: string;
  /** 容器启动时间（ISO 8601）；适配器拿不到时为 null */
  startedAt: string | null;
  /** 实际发布的宿主机端口：llamapad.host_port 标签优先；无标签（旧版面板起的容器）
   *  退回合并配置；模型行也已删除 → null（health 采集、排空、反代按"无目标"降级） */
  hostPort: number | null;
}

/** 指标采集 / 反代 / AI 解析沿用的旧名，形态与 RunningModel 一致 */
export type RunningContainerInfo = RunningModel;

/** 容器的宿主机端口：标签优先，无标签退回该模型当前的合并配置，模型行也没了返回 null */
function hostPortOf(container: ContainerStatus, repo: ModelRepo, defaults: DefaultConfig): number | null {
  const raw = container.labels?.[HOST_PORT_LABEL];
  if (raw !== undefined) {
    const port = Number(raw);
    if (Number.isInteger(port) && port >= 1 && port <= 65_535) return port;
  }
  const row = repo.getModel(container.labels?.[MODEL_LABEL] ?? container.name);
  return row ? mergeConfig(defaults, row.overrides ?? {}).docker.host_port : null;
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
 * 列出全部正在运行的托管模型，按启动时间升序（最早启动的在前）。
 * 排序不能省：docker API 的返回顺序不保证稳定，默认模型决议与采集目标都依赖"第一个"是谁。
 */
export async function listRunningModelInfos(
  db: Database.Database,
  adapter: DockerAdapter,
): Promise<RunningModel[]> {
  const running = await listRunningManaged(adapter);
  if (running.length === 0) return [];

  const repo = createModelRepo(db);
  const defaults = repo.getDefaultConfig();
  return sortByStartedAt(
    running.map((container) => ({
      model: container.labels![MODEL_LABEL],
      container: container.name,
      startedAt: container.startedAt,
      hostPort: hostPortOf(container, repo, defaults),
    })),
  );
}

/**
 * 取一个运行中模型的采集信息：preferred 在跑就取它，否则取最早启动的那个；无运行返回 null。
 * 指标采集（跟随默认模型，见 locators.ts）与测试共用。
 */
export async function getRunningContainerInfo(
  db: Database.Database,
  adapter: DockerAdapter,
  preferred: string | null = null,
): Promise<RunningContainerInfo | null> {
  const infos = await listRunningModelInfos(db, adapter);
  return infos.find((info) => info.model === preferred) ?? infos[0] ?? null;
}

/** getRuntimeStatus 返回形态 */
export interface RuntimeStatus {
  /** 默认模型那一项。保留这个字段是为了兼容：单模型时代的调用方（含 llamapad-dsh-plugin）
   *  都读它；无模型运行时为 null */
  running: RunningModel | null;
  /** 全部运行中的托管模型，按启动时间升序 */
  models: RunningModel[];
  /** 当前默认模型名（API 中转不带 model 时的目标）；无模型运行时为 null */
  defaultModel: string | null;
}

/** 运行中模型名集合（运行中锁定判定用：删除配置、移动文件等） */
export function runningModelNames(status: RuntimeStatus): ReadonlySet<string> {
  return new Set(status.models.map((m) => m.model));
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
  /** 设置默认模型；该模型没在运行 → DefaultModelNotRunningError */
  setDefaultModel(name: string): Promise<void>;
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
  /** 宿主机端口占用探测（见 portProbe.ts）：启动时发现被占就顺延。
   *  未注入视为全部空闲，只靠 docker 的端口冲突报错兜底 */
  isPortInUse?: (port: number) => Promise<boolean>;
}

/** options.drain=true 但未显式给 drainTimeoutMs 时的默认超时（毫秒）。
 *  三个启停路由的 zod `.default()` 直接复用本常量，四处不各写一份数字。 */
export const DEFAULT_DRAIN_TIMEOUT_MS = 60_000;

/** 启动时端口分配的最大尝试次数（探测到占用 + docker 报端口冲突合计）。
 *  最后一次尝试不再探测，直接交给 docker 判定，避免探测误报把启动卡死 */
export const MAX_SLOT_ATTEMPTS = 10;

/** 迟退检测的豁免窗口：面板自己停掉的模型在这段时间内消失不算异常退出 */
const PANEL_ACTION_GRACE_MS = 10_000;

/** 重叠运行的 run 结束时写入的聚合值：整卡读数混着别的模型，宁缺毋滥（决策 D9） */
const NO_AGGREGATES: RunAggregates = { avgTokensPerSec: null, peakTokensPerSec: null, peakGpuMemMib: null };

/** exclusive() 包装的三个动作名（RuntimeBusyError.runningAction 的取值范围） */
type RuntimeAction = "start" | "stop" | "restart";

const RUNTIME_ACTION_LABEL: Record<RuntimeAction, string> = {
  start: "启动",
  stop: "停止",
  restart: "重启",
};

/**
 * 运行时忙：同一模型上一个启停请求尚未结束，本次请求被直接拒绝（真机实测的并发
 * 缺陷，见 exclusive() 头注释）。不同模型之间互不阻塞。故意不做排队——"抢不到就
 * 重试"对用户更直观，排队会让一连串点击在后台依次生效，结果难以预期。
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

/** 设为默认的模型没在运行（决策 D5：没有可用模型就无法选择） */
export class DefaultModelNotRunningError extends Error {
  constructor(readonly model: string) {
    super(`模型 ${model} 没有在运行，不能设为默认模型`);
    Object.setPrototypeOf(this, DefaultModelNotRunningError.prototype);
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

  /**
   * 容器名/端口占位表（key = 模型名）：分配出来就登记，模型停止、启动失败、异常退出时移除。
   * 只靠 docker 列表判断占用不够——两个启动请求并发时，彼此的容器都还没创建出来。
   * 登记发生在分配之后、任何 await 之前（见 launchWithSlot），并发的另一个启动在自己的
   * 分配点一定能看到。
   */
  const slots = new Map<string, ContainerSlot>();

  /**
   * 默认模型（决策 D5）：进程内状态，不落库，面板重启后按最早启动的在跑模型重建。
   * 存的是"用户意图"，读的时候再和实际运行集合比对（getRuntimeStatus）：
   * - 启动时为空 → 设为本次启动的模型
   * - 手动停止 → 当场换成最早启动的在跑模型；异常退出 → 在检测到退出的那次状态读取里换
   * - 重启（同名重建）→ 不清空，重启完成后仍是它
   */
  let defaultModel: string | null = null;

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
   * 运行时间与别的模型重叠过的 run（key = 模型名）。启动时有别的模型在跑，
   * 新旧双方都记进来；run 结束时查一次并移除。面板重启后集合清空，但
   * reconcileOpenRuns 会用重启后首次观测到的运行中模型集合补回重叠标记
   * （见该函数），重启前就并行的 run 不会因此错误地走完整聚合。
   */
  const overlappedRuns = new Set<string>();

  /** 结束该模型的悬空 run（若存在）；重叠过的 run 聚合值记 NULL */
  function finishRun(model: string, endReason: string): void {
    const overlapped = overlappedRuns.delete(model);
    const open = runsRepo.getOpenRun(model);
    if (!open) return;
    const aggregates = overlapped ? NO_AGGREGATES : computeAggregates(open.started_at, Date.now());
    runsRepo.closeRun(open.id, endReason, aggregates);
  }

  // 迟退检测状态（M4 真机，多模型版）：上次观察到的运行模型集合 + 各模型最近一次面板操作时间
  let lastObserved = new Set<string>();
  const panelActionAt = new Map<string, number>();
  const notePanelAction = (name: string) => {
    panelActionAt.set(name, Date.now());
  };

  /**
   * 排空判定（仅 options.drain 为真时执行）：hostPort 由调用方从待停容器取
   * （hostPortOf：标签优先）。拿不到端口或 deps.waitForIdle 未注入 → 跳过排空，
   * 直接落 {drained:true, reason:"skipped"}（放行，不阻塞停止）。
   */
  async function drainBeforeStop(
    hostPort: number | null,
    options: RuntimeActionOptions | undefined,
  ): Promise<DrainOutcome | undefined> {
    if (!options?.drain) return undefined;
    if (!deps?.waitForIdle) return { drained: true, reason: "skipped" };
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
      drain = await drainBeforeStop(hostPortOf(container, repo, repo.getDefaultConfig()), options);
      notePanelAction(name);
      await adapter.stop(container.name);
      record(EVENT_STOP, `停止模型 ${name}（${reason}）${drainSuffix(drain)}`);
      finishRun(name, endReason);
    }
    slots.delete(name);
    // 面板主动停止的模型直接移出观察集合：不依赖 10s 豁免窗口，隔多久再查状态都不会误报迟退
    lastObserved.delete(name);
    return drain;
  }

  /** self 以外的模型占用的容器名与端口：运行中的容器 + 占位表 */
  function takenSlots(self: string, others: readonly RunningModel[]): { names: Set<string>; ports: Set<number> } {
    const names = new Set<string>();
    const ports = new Set<number>();
    for (const other of others) {
      if (other.model === self) continue;
      names.add(other.container);
      if (other.hostPort !== null) ports.add(other.hostPort);
    }
    for (const [model, slot] of slots) {
      if (model === self) continue;
      names.add(slot.name);
      ports.add(slot.hostPort);
    }
    return { names, ports };
  }

  /**
   * 分配容器名与端口并启动容器。端口被占（探测为真，或 docker 报端口冲突）时
   * 把该端口记入 skippedPorts 重新分配，最多 MAX_SLOT_ATTEMPTS 次；其他错误直接失败。
   * 失败时释放占位并记 model.start_failed。
   */
  async function launchWithSlot(
    model: ModelConfig,
    defaults: DefaultConfig,
    configured: DockerConfig,
    resolved: ResolvedModelPaths,
    others: readonly RunningModel[],
  ): Promise<{ started: { id: string }; spec: ContainerSpec }> {
    const skippedPorts = new Set<number>();
    try {
      for (let attempt = 1; ; attempt++) {
        const taken = takenSlots(model.name, others);
        for (const port of skippedPorts) taken.ports.add(port);
        const slot = allocateContainerSlot({
          model: model.name,
          configuredName: configured.container_name,
          configuredPort: configured.host_port,
          takenNames: taken.names,
          takenPorts: taken.ports,
        });
        // 先登记再 await：并发启动的另一个模型在自己的分配点能看到这个占位
        slots.set(model.name, slot);

        const lastAttempt = attempt >= MAX_SLOT_ATTEMPTS;
        if (!lastAttempt && deps?.isPortInUse !== undefined && (await deps.isPortInUse(slot.hostPort))) {
          skippedPorts.add(slot.hostPort);
          continue;
        }

        const spec = buildContainerSpec(model, defaults, hostModelsRoot, resolved, slot);
        try {
          return { started: await adapter.start(spec), spec };
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          if (!lastAttempt && isPortBindError(reason)) {
            skippedPorts.add(slot.hostPort);
            continue;
          }
          throw error;
        }
      }
    } catch (error) {
      slots.delete(model.name);
      const reason = error instanceof Error ? error.message : String(error);
      record(EVENT_START_FAILED, `启动模型 ${model.name} 失败: ${reason}`);
      throw error;
    }
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
   *
   * 判定函数与保存侧（edit-form.tsx）同一份 shouldBlockEffortSave，而不是只看值域的
   * isEffortAllowed：思考模式关闭时 reasoning_effort 分支整段不参与渲染（真机实测的
   * chat template 把该分支包在 enable_thinking 判断内），此时传值域外的值不会触发
   * jinja 的 raise_exception，继续拦下会把启动焊死——且思考关闭时编辑页的选择器是
   * 禁用的，用户无从改掉这个值，只能先开思考、改值、再关回去才能启动。
   * enable_thinking 取合并后的生效值，取法与上面 effort 同源。
   */
  async function assertReasoningEffortAllowed(model: ModelConfig): Promise<void> {
    const merged = mergeConfig(repo.getDefaultConfig(), model.overrides ?? {}).server;
    const effort = merged.reasoning_effort;
    if (effort === "inherit") return;

    const gguf = resolveModelFiles(panelModelsRoot, model.gguf_file);
    if (gguf.missing || gguf.files.length === 0) return;

    const meta = await getGgufMeta(db, path.join(panelModelsRoot, gguf.files[0].rel));
    const support = detectReasoningEffort(meta?.chatTemplate ?? null);
    if (shouldBlockEffortSave(effort, support, merged.enable_thinking)) {
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
    // specification——必须在这里挡且必须挡在停旧容器之前：
    // 校验失败不能有副作用，不能因为路径没配就先把正在跑的模型停了
    if (model.overrides?.docker?.model_volume === undefined && hostModelsRoot.trim() === "") {
      throw new Error(
        "models 宿主机路径未解析：请设置环境变量 PANEL_MODELS_HOST，或在 panel.yaml 配置 paths.models.host，或确认面板容器已挂载模型目录",
      );
    }

    // 文件检查走 panel 根：gguf / 已配置的 mmproj 任一缺失即拒绝启动（不触碰现有容器）。
    // draft_file 多一道「开关真的开着」的门槛，见下方注释
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
    // draft_file 的存在性只在 MTP 真的启用时才校验：spec_type 为 none 时
    // core/args.ts 压根不下发 -md（配置里留着加速权重、开关关掉属"暂时停用"，
    // 是合法状态），为一个根本不会被用到的文件拒绝启动等于把整个模型焊死——
    // 用户把 sidecar 删了或挪了位置，连"关掉开关照常跑"这条退路都没有。
    // mmproj 没有这道门槛：它配了就一定下发，校验恒有意义。
    // 合并值的取法与 assertReasoningEffortAllowed 同源，不另开一条取配置的路。
    const specType = mergeConfig(repo.getDefaultConfig(), model.overrides ?? {}).server.spec_type;
    if (model.draft_file !== undefined && specType !== "none") {
      const draft = resolveModelFiles(panelModelsRoot, model.draft_file);
      if (draft.missing || draft.files.length === 0) {
        throw new Error(`模型文件缺失: ${model.draft_file}`);
      }
      resolved.draftRel = draft.files[0].rel;
    }

    // MTP 开着但没关联 draft_file 时，权重本身是否自带 MTP 层决定这是否会直接炸：
    // embedded（权重自带 MTP 层）留空 draft_file 是正常用法，llama-server 拿主模型自己
    // 建 MTP 上下文即可；none（不含 MTP 层）时同样的操作会被 llama-server 拒绝启动
    // ——真机实测 Qwen3.8-27B-UD-IQ1_S.gguf（nextn=0）开 --spec-type draft-mtp 不给 -md：
    // `context type MTP requested but model doesn't contain MTP layers`，容器直接退出。
    // 与上面三处文件校验同理，必须挡在停旧容器之前；元数据读不到（返回 null）时不拦——
    // 未知就放行，与 resolveMtpKind 自身"缺信息时保守放行"的立场一致。
    if (specType !== "none" && model.draft_file === undefined) {
      const mainMeta = await getGgufMeta(db, path.join(panelModelsRoot, resolved.ggufRel));
      if (mainMeta !== null && resolveMtpKind(mainMeta) === "none") {
        throw new Error(
          `该权重不含 MTP 层，开启 MTP 必须关联加速权重（draft_file），否则 llama-server 会拒绝启动: ${model.gguf_file}`,
        );
      }
    }

    // reasoning_effort 前置校验：与上面三处文件校验同理，必须挡在停旧容器之前——
    // 配置非法就该直接拒绝启动，不能先把用户正在跑的模型停了再报错。
    // 函数体共享给 restartModel（见 assertReasoningEffortAllowed 头部注释）。
    await assertReasoningEffortAllowed(model);

    // 同名重建：只停本模型自己的旧容器。其他模型照常运行（决策 D1），
    // 容器名与端口的冲突交给下面的分配逻辑错开
    const drain = await stopByName(name, "重建容器", "recreated", options);
    const others = await listRunningModelInfos(db, adapter);

    // baseline 必须在本模型旧容器已停之后采样：同名重建时旧容器占的显存不能算进新 run 的
    // baseline，否则净增量被严重低估甚至为负
    const baselineMib = deps?.getGpuMemUsedMib?.() ?? null;
    const totalMib = deps?.getGpuMemTotalMib?.() ?? null;

    const defaults = repo.getDefaultConfig();
    const configured = mergeConfig(defaults, model.overrides ?? {}).docker;
    const { started, spec } = await launchWithSlot(model, defaults, configured, resolved, others);

    const shifted =
      spec.hostPort !== configured.host_port
        ? `，端口 ${configured.host_port} 被占用，改用 ${spec.hostPort}`
        : "";
    record(EVENT_START, `启动模型 ${name}（容器 ${spec.name}${shifted}）`);
    runsRepo.openRun(name, baselineMib, totalMib);
    if (others.length > 0) {
      overlappedRuns.add(name);
      for (const other of others) overlappedRuns.add(other.model);
    }
    lastObserved.add(name); // 启动成功即视为已观察到运行（迟退检测基线，无需等首次查询）
    if (defaultModel === null) defaultModel = name;
    return drain !== undefined ? { id: started.id, drain } : { id: started.id };
  }

  async function stopModel(
    name: string,
    options?: RuntimeActionOptions,
  ): Promise<DrainOutcome | undefined> {
    const drain = await stopByName(name, "手动停止", "stopped", options);
    // 手动停掉默认模型：当场换成最早启动的在跑模型。不能只清空等下次读状态再补——
    // 用户停掉后立刻把它启动回来的话，startModel 看到空值会把默认又设回它。
    // 不放进 stopByName：重启与同名重建也走 stopByName，那两种情况默认模型不该变
    if (defaultModel === name) {
      defaultModel = resolveDefaultModel(null, await listRunningModelInfos(db, adapter));
    }
    return drain;
  }

  async function setDefaultModel(name: string): Promise<void> {
    const models = await listRunningModelInfos(db, adapter);
    if (!models.some((m) => m.model === name)) throw new DefaultModelNotRunningError(name);
    defaultModel = name;
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

  /**
   * 迟退检测（M4 真机，多模型版）：启动成功后进程崩溃（容器消失），attach 摘要只覆盖
   * 瞬退（10s 窗口内），迟退在此补事件。逐个模型比对上次观察集合；正在启停中的模型
   * （inFlight）与面板刚操作过的模型不算异常。
   */
  function detectExits(observed: ReadonlySet<string>): void {
    const now = Date.now();
    for (const name of lastObserved) {
      if (observed.has(name) || inFlight.has(name)) continue;
      if (now - (panelActionAt.get(name) ?? 0) <= PANEL_ACTION_GRACE_MS) continue;
      record("model.exit", `模型 ${name} 的容器已退出（非面板操作，疑似异常）`);
      finishRun(name, "exited");
      slots.delete(name);
      if (defaultModel === name) defaultModel = null;
    }
    lastObserved = new Set(observed);
  }

  /**
   * 悬空 run 对账（U17，面板重启场景）：面板重启后进程内存态清零，但上次的 run
   * 可能还是 ended_at IS NULL（llama-server 是兄弟容器，面板停了不影响它继续跑）。
   * 模型仍在跑 → 连续的一次运行，保留最新那条；模型已不在跑，或同一模型的更早悬空行
   * （历史遗留）→ 关闭并记 panel_restart。
   */
  function reconcileOpenRuns(observed: ReadonlySet<string>): void {
    const kept = new Set<string>();
    for (const open of runsRepo.listOpenRuns()) {
      if (observed.has(open.model) && !kept.has(open.model)) {
        kept.add(open.model);
        continue;
      }
      runsRepo.closeRun(open.id, "panel_restart", computeAggregates(open.started_at, Date.now()));
    }
    // 重启前就并行、重启后仍在跑的模型，overlappedRuns 是进程内 Set 随重启清空，
    // 单靠 kept 的延续关系无从得知它们之前就重叠过——本轮观测到不止一个运行中模型时
    // 直接补回重叠标记，这些 run 结束时才会正确写 NULL 聚合值，而不是把整卡读数当净增量
    if (observed.size > 1) {
      for (const name of observed) overlappedRuns.add(name);
    }
  }

  async function getRuntimeStatus(): Promise<RuntimeStatus> {
    const models = await listRunningModelInfos(db, adapter);
    const observed = new Set(models.map((m) => m.model));

    detectExits(observed);

    // 对账只做一次：本函数本就查运行容器、又被采集器每轮与页面轮询调用，无需新增启动钩子
    if (!reconciled) {
      reconciled = true;
      reconcileOpenRuns(observed);
    }

    const effective = resolveDefaultModel(defaultModel, models);
    // 默认模型正在重启时容器短暂不在，这期间读到的 effective 是临时替身，不能写回，
    // 否则重启完成后默认模型就变成了替身
    if (defaultModel === null || !inFlight.has(defaultModel)) defaultModel = effective;

    return {
      running: models.find((m) => m.model === effective) ?? null,
      models,
      defaultModel: effective,
    };
  }

  // 进程内互斥（真机实测的并发缺陷），按模型分桶：同一模型的第二个启停请求进来时，
  // 同名重建会把第一个请求刚创建、还在加载模型的容器 SIGKILL 掉（exit 137），第一个
  // 请求的启动轮询随后误报「容器启动即退出」。不同模型互不停止对方，不需要互斥；
  // 它们之间的端口/容器名冲突由 slots 占位表解决。本面板是单进程 Next.js standalone
  // （不支持多实例），进程内锁足够。
  //
  // 只包在这里（return 的服务对象）而不是包进 startModel/stopModel/restartModel
  // 函数体内：restartModel 内部是直接调本地闭包里的 startModel / stopByName，
  // 走的是未包装的本地函数，天然不会自锁；若改成在函数体内加锁，restartModel 会在
  // 调用内部 startModel 时把自己已经持有的锁当成"被占用"而拒绝自己。
  //
  // getRuntimeStatus 绝对不包在互斥里：它是只读查询，且启动弹窗与 Chat 加载态
  // 都在启动期间每 2s 轮询它——锁住它会让整个进度界面在锁定期间瞎掉。
  const inFlight = new Map<string, RuntimeAction>();

  function exclusive<A extends unknown[], R>(
    action: RuntimeAction,
    fn: (name: string, ...rest: A) => Promise<R>,
  ): (name: string, ...rest: A) => Promise<R> {
    return async (name, ...rest) => {
      const running = inFlight.get(name);
      if (running !== undefined) throw new RuntimeBusyError(running, name);
      inFlight.set(name, action);
      try {
        return await fn(name, ...rest);
      } finally {
        // 无论成败都必须释放：漏写这一步会让该模型永久锁死（一次失败的启动就再也起不来）
        inFlight.delete(name);
      }
    };
  }

  return {
    startModel: exclusive("start", startModel),
    stopModel: exclusive("stop", stopModel),
    restartModel: exclusive("restart", restartModel),
    getRuntimeStatus,
    setDefaultModel,
  };
}
