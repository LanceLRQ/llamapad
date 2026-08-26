import { formatSize } from "@/lib/format";

/**
 * 环境自检 Doctor（UX P1 U18）：六项独立检查——docker 连通、models 目录可写、
 * 路径映射是否配置、GPU 可用性、HF 连通、磁盘空间。全部依赖注入（DoctorDeps），
 * 本文件不碰真实文件系统/网络/Docker，真实实现在 route 层装配（真实 deps 见
 * `src/app/api/v1/doctor/route.ts`），保证本文件可纯单测。
 *
 * 六项并发跑且互不牵连：任一项的依赖函数抛错都在各自检查函数内部兜底为该项的
 * fail/warn，不会让 Promise.all 整体 reject 拖垮其余五项（诊断工具本身必须比
 * 被诊断的系统更抗折腾——docker 打不通不该连 HF 检查结果都看不到）。
 */

export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorItem {
  id: string;
  status: DoctorStatus;
  detail?: string;
  values?: Record<string, string | number>;
}

/** modelsDir 检查结果：目录存在且可写 = ok；不存在/不可写 = fail（detail 携带引导文案） */
export interface ModelsDirCheckResult {
  status: "ok" | "fail";
  detail?: string;
}

/** nvidia-smi 三态探测状态，与 `src/server/metrics/nvidiaSmi.ts` 的 NvidiaStatus 同构（不直接 import，保持本文件零依赖） */
export type DoctorGpuStatus = "probing" | "available" | "unavailable";

/** HF 连通测试的最小依赖形态（真实实现 testHfConnection 的返回值是其超集，结构兼容） */
export interface DoctorHfResult {
  ok: true;
  account: string;
}

export interface DoctorDeps {
  /** docker 是否可达：成功即视为 ok，失败原样上抛由本文件兜底为 fail */
  listContainers: () => Promise<unknown[]>;
  /** models 目录存在性 + 可写性探测（真实实现见 route 层：写临时文件再 unlink） */
  checkModelsDir: () => Promise<ModelsDirCheckResult>;
  /** 当前生效的 models 路径映射（host/panel 视角） */
  getPathMap: () => { host: string; panel: string };
  /** 面板自身是否运行在容器内（真实实现探测 /.dockerenv） */
  inContainer: () => boolean;
  /** GPU 三态探测状态 */
  gpuStatus: () => DoctorGpuStatus;
  /** HF 连通测试：成功 resolve，失败 reject（与 testHfConnection 同约定） */
  testHf: () => Promise<DoctorHfResult>;
  /** models 根所在分区的剩余字节数 */
  freeBytes: () => Promise<number>;
}

const GB = 1024 ** 3;

async function checkDocker(deps: DoctorDeps): Promise<DoctorItem> {
  try {
    await deps.listContainers();
    return { id: "docker", status: "ok" };
  } catch (e) {
    return {
      id: "docker",
      status: "fail",
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

async function checkModelsDirItem(deps: DoctorDeps): Promise<DoctorItem> {
  try {
    const r = await deps.checkModelsDir();
    return { id: "modelsDir", status: r.status, detail: r.detail };
  } catch (e) {
    return {
      id: "modelsDir",
      status: "fail",
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

async function checkPathMap(deps: DoctorDeps): Promise<DoctorItem> {
  try {
    const map = deps.getPathMap();
    if (map.host.trim() === "" || map.panel.trim() === "") {
      return { id: "pathMap", status: "fail", detail: "路径映射未配置（host/panel 为空），请检查 panel.yaml 的 paths.models" };
    }
    // 容器内 host==panel 多半是没配挂载映射（面板与宿主机共享同一路径字符串纯属巧合）；
    // 非容器环境（如 Mac 本机开发）host==panel 是正常态，不能一概而论
    if (map.host === map.panel && deps.inContainer()) {
      return {
        id: "pathMap",
        status: "warn",
        detail: `host 与 panel 路径相同（${map.host}），容器内运行时通常需要配置不同的挂载路径，请检查 panel.yaml 的 paths.models 映射`,
      };
    }
    return { id: "pathMap", status: "ok" };
  } catch (e) {
    return { id: "pathMap", status: "fail", detail: e instanceof Error ? e.message : String(e) };
  }
}

async function checkGpu(deps: DoctorDeps): Promise<DoctorItem> {
  try {
    const status = deps.gpuStatus();
    if (status === "available") return { id: "gpu", status: "ok" };
    if (status === "probing") return { id: "gpu", status: "warn", detail: "GPU 探测中，稍后重试" };
    // unavailable 是 warn 不是 fail：纯 CPU 部署是合法形态，不应吓退用户
    return { id: "gpu", status: "warn", detail: "未检测到可用 GPU（纯 CPU 部署下属正常）" };
  } catch (e) {
    return { id: "gpu", status: "warn", detail: e instanceof Error ? e.message : String(e) };
  }
}

async function checkHf(deps: DoctorDeps): Promise<DoctorItem> {
  try {
    const r = await deps.testHf();
    return { id: "hf", status: "ok", detail: r.account };
  } catch (e) {
    // HF 只影响下载功能，不影响本地已下载模型的启停，失败只 warn
    return { id: "hf", status: "warn", detail: e instanceof Error ? e.message : String(e) };
  }
}

async function checkDisk(deps: DoctorDeps): Promise<DoctorItem> {
  try {
    const free = await deps.freeBytes();
    const detail = `剩余 ${formatSize(free)}`;
    const values = { freeBytes: free };
    if (free < GB) return { id: "disk", status: "fail", detail, values };
    if (free < 5 * GB) return { id: "disk", status: "warn", detail, values };
    return { id: "disk", status: "ok", detail, values };
  } catch (e) {
    return { id: "disk", status: "fail", detail: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 单项超时上限：Doctor 是「点一下看环境」的即时反馈，不能被最慢的一项拖住。
 * 实测 Mac 无代理环境下 HF 连通性检查要等 10.5s 才失败，整个面板卡在转圈——
 * 超时归为 warn（「这项没测出来」而非「这项坏了」），其余项照常呈现。
 */
const ITEM_TIMEOUT_MS = 4_000;

/** 给单项检查套超时；超时返回 warn 而非让 Promise.all 悬着 */
async function withTimeout(id: string, task: Promise<DoctorItem>): Promise<DoctorItem> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<DoctorItem>((resolve) => {
    timer = setTimeout(
      () => resolve({ id, status: "warn", detail: "检查超时，未能得出结论" }),
      ITEM_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([task, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** 六项并发跑，返回顺序固定（docker → modelsDir → pathMap → gpu → hf → disk），供前端稳定渲染 */
export async function runDoctor(deps: DoctorDeps): Promise<DoctorItem[]> {
  return Promise.all([
    withTimeout("docker", checkDocker(deps)),
    withTimeout("modelsDir", checkModelsDirItem(deps)),
    withTimeout("pathMap", checkPathMap(deps)),
    withTimeout("gpu", checkGpu(deps)),
    withTimeout("hf", checkHf(deps)),
    withTimeout("disk", checkDisk(deps)),
  ]);
}
