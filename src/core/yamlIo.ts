import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { BUILTIN_DEFAULT_CONFIG } from "./config";
import {
  defaultConfigSchema,
  dockerConfigSchema,
  modelSchema,
  serverConfigSchema,
  type DefaultConfig,
  type ModelConfig,
  type Overrides,
} from "./schemas";

/**
 * YAML 导入导出纯函数（M2 Task 8）
 *
 * SQLite 是配置真源，YAML 是导入/导出格式 + 每次变更自动单向快照
 * （DB → YAML，永不反向）。三类内容：
 * - llamapad 导出格式：default_config / models / namespaces 三段
 * - bash 前身（llama-launcher）单模型格式：model: + overrides:（导入落 main 空间）
 * - bash 前身 default.yaml：字段映射（gpu_devices→gpu、缺字段内置默认补齐）
 *
 * 错误契约：与 core/config.ts / repo/models.ts 一致——校验失败抛普通 Error，
 * message 自行拼接 issue 的 path.join(".") + message（zod 4），保证字段路径
 * （如 default_config.docker.gpu）出现在 message 中，调用方无需处理 ZodError。
 */

// ---------- llamapad 导出格式 ----------

export interface ExportBundle {
  defaults: DefaultConfig;
  models: ModelConfig[];
  namespaces: string[];
}

/** 导出文件结构：三段，字段名与 DB/设计文档一致 */
const exportBundleSchema = z.object({
  default_config: defaultConfigSchema,
  models: z.array(modelSchema),
  namespaces: z.array(z.string().min(1)),
});

/** zod issues → message 含字段路径的 Error（全文件统一惯例） */
function fieldPathError(what: string, issues: { path: PropertyKey[]; message: string }[]): never {
  const detail = issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
  throw new Error(`${what}: ${detail}`);
}

/** YAML.parse 包装：语法错误 → message 表明是 YAML 解析失败并带原因 */
function parseYamlOrThrow(text: string, what: string): unknown {
  try {
    return parseYaml(text);
  } catch (error) {
    throw new Error(`YAML 解析失败（${what}）: ${(error as Error).message}`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 导出为 YAML 文本。入参先过 exportBundleSchema：一是剥离 StoredModel 的
 * created_at / updated_at 等多余键（zod 默认丢弃未知键），二是保证导出内容
 * 一定可被 fromExportYaml 读回（写入端就拒坏数据，而不是导出后读不回）。
 * lineWidth: 0 禁止折行——长 URL / 中文注释不换行，文件对 git diff 友好。
 */
export function toExportYaml(bundle: ExportBundle): string {
  const parsed = exportBundleSchema.safeParse({
    default_config: bundle.defaults,
    models: bundle.models,
    namespaces: bundle.namespaces,
  });
  if (!parsed.success) fieldPathError("导出数据校验失败", parsed.error.issues);
  return stringifyYaml(parsed.data, { lineWidth: 0 });
}

/** 读回导出 YAML：坏 YAML / 缺段 / schema 不符均抛 message 带字段路径的 Error */
export function fromExportYaml(text: string): ExportBundle {
  const raw = parseYamlOrThrow(text, "导出文件");
  const parsed = exportBundleSchema.safeParse(raw);
  if (!parsed.success) fieldPathError("导出文件校验失败", parsed.error.issues);
  return {
    defaults: parsed.data.default_config,
    models: parsed.data.models,
    namespaces: parsed.data.namespaces,
  };
}

// ---------- bash 前身格式 ----------

/**
 * bash 的 gpu_devices → llamapad gpu：
 * "all"/缺省 → "all"；"none" → "none"；"0,1" → "device=0,1"（bash 版拼
 * `--gpus "device=<v>"` 的同款语义）；其余原样透传，交给 schema 报字段路径。
 */
function mapBashGpu(value: unknown): string {
  const s = value === undefined || value === null ? "" : String(value).trim();
  if (s === "" || s === "all") return "all";
  if (/^\d+(,\d+)*$/.test(s)) return `device=${s}`;
  return s;
}

/** bash 某段（docker/server）已知字段集合（gpu_devices 单独映射，不在此列） */
const DOCKER_KNOWN = new Set(Object.keys(dockerConfigSchema.shape));
const SERVER_KNOWN = new Set(Object.keys(serverConfigSchema.shape));

/** known 参数的取值说明，warning 文案用（中英混排无妨，警告只在结果里透出一次） */
const IGNORED_NOTE = "llamapad 不支持，已忽略";

/**
 * bash overrides → llamapad overrides：
 * - docker 段的 gpu_devices 映射为 gpu
 * - 已知字段透传（值合法性由后续 modelSchema 校验裁决，错误带字段路径）
 * - bash 独有字段（jinja / no_mmap 等）→ warnings 收集，不抛错
 */
function filterBashOverrides(raw: unknown, warnings: string[]): Overrides {
  if (raw === undefined || raw === null) return {};
  if (!isPlainObject(raw)) throw new Error("bash overrides 段格式错误：必须是映射");

  const out: Partial<Record<"docker" | "server", Record<string, unknown>>> = {};
  for (const section of ["docker", "server"] as const) {
    const sectionRaw = raw[section];
    if (sectionRaw === undefined || sectionRaw === null) continue;
    if (!isPlainObject(sectionRaw)) {
      throw new Error(`bash overrides.${section} 段格式错误：必须是映射`);
    }
    const known = section === "docker" ? DOCKER_KNOWN : SERVER_KNOWN;
    const filtered: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(sectionRaw)) {
      if (section === "docker" && key === "gpu_devices") {
        filtered.gpu = mapBashGpu(value);
        continue;
      }
      if (known.has(key)) filtered[key] = value;
      else warnings.push(`overrides.${section}.${key}（${IGNORED_NOTE}）`);
    }
    if (Object.keys(filtered).length > 0) out[section] = filtered;
  }
  return out as Overrides;
}

/** bash 单模型解析结果：模型 + 不支持字段的 warning 列表 */
export interface BashModelParse {
  model: ModelConfig;
  warnings: string[];
}

/**
 * bash 前身（llama-launcher）单模型 YAML → ModelConfig：
 * - model.name / display_name 透传（display_name 缺省回退 name）
 * - gguf_file / mmproj_file 为 models 根下裸文件名 → 加 `main/` 前缀
 *   （bash 无 namespace 概念，统一落 main 空间）
 * - overrides.server / overrides.docker 子集透传，bash 独有字段收集 warning
 * - 组装结果过 modelSchema，非法值抛 message 带字段路径的 Error
 */
export function fromBashYaml(text: string): BashModelParse {
  const root = parseYamlOrThrow(text, "bash 模型文件");
  if (!isPlainObject(root)) {
    throw new Error("bash 模型文件格式错误：顶层必须是映射（model: / overrides:）");
  }
  const modelRaw = root.model;
  if (!isPlainObject(modelRaw)) throw new Error("bash 模型文件缺少 model 段");

  const warnings: string[] = [];
  const name = modelRaw.name;
  const displayName =
    typeof modelRaw.display_name === "string" && modelRaw.display_name !== ""
      ? modelRaw.display_name
      : name; // 缺省回退 name（保持 string 类型，空值交 schema 裁决）

  // gguf_file 语义 = 相对 models 根的路径（运行时 resolveModelFiles 直接按此解析，
  // namespace 只是逻辑分组）。裸文件名 → main/<file>（bash 无目录结构时落 main 目录）；
  // 已含目录的路径原样保留——加 main/ 前缀会指向不存在的 main/<子目录>/
  // （M4 真机发现：llama-launcher 配置的 gguf_file 本就含子目录）
  const namespaced = (value: unknown): string | undefined => {
    if (typeof value !== "string" || value === "") return undefined;
    return value.includes("/") ? value : `main/${value}`;
  };

  const candidate = {
    name,
    display_name: displayName,
    namespace: "main",
    gguf_file: namespaced(modelRaw.gguf_file),
    mmproj_file: namespaced(modelRaw.mmproj_file),
    overrides: filterBashOverrides(root.overrides, warnings),
  };

  const parsed = modelSchema.safeParse(candidate);
  if (!parsed.success) fieldPathError("bash 模型校验失败", parsed.error.issues);
  return { model: parsed.data, warnings };
}

/**
 * bash 前身 default.yaml → DefaultConfig：
 * - docker.gpu_devices → gpu；host_port 等同名直传；缺字段（含整段缺失）
 *   由 BUILTIN_DEFAULT_CONFIG 补齐（container_port 缺省 8080 即来源于此）
 * - server 段同名直传；bash 独有字段（jinja / no_mmap）→ warning
 * - 结果过 defaultConfigSchema，非法值抛 message 带字段路径的 Error
 */
export function fromBashDefaultYaml(text: string): { defaults: DefaultConfig; warnings: string[] } {
  const root = parseYamlOrThrow(text, "bash default.yaml");
  if (!isPlainObject(root)) {
    throw new Error("bash default.yaml 格式错误：顶层必须是映射（docker: / server:）");
  }

  const warnings: string[] = [];
  const docker: Record<string, unknown> = { ...BUILTIN_DEFAULT_CONFIG.docker };
  if (root.docker !== undefined && root.docker !== null) {
    if (!isPlainObject(root.docker)) throw new Error("bash default.yaml 的 docker 段必须是映射");
    for (const [key, value] of Object.entries(root.docker)) {
      if (key === "gpu_devices") {
        docker.gpu = mapBashGpu(value);
        continue;
      }
      if (key in BUILTIN_DEFAULT_CONFIG.docker) docker[key] = value;
      else warnings.push(`docker.${key}（${IGNORED_NOTE}）`);
    }
  }

  const server: Record<string, unknown> = { ...BUILTIN_DEFAULT_CONFIG.server };
  if (root.server !== undefined && root.server !== null) {
    if (!isPlainObject(root.server)) throw new Error("bash default.yaml 的 server 段必须是映射");
    for (const [key, value] of Object.entries(root.server)) {
      if (key in BUILTIN_DEFAULT_CONFIG.server) server[key] = value;
      else warnings.push(`server.${key}（${IGNORED_NOTE}）`);
    }
  }

  const parsed = defaultConfigSchema.safeParse({ docker, server });
  if (!parsed.success) fieldPathError("bash default.yaml 校验失败", parsed.error.issues);
  return { defaults: parsed.data, warnings };
}

// ---------- 导入冲突策略 ----------

export type ImportStrategy = "skip" | "rename" | "overwrite";

/** applyImportConflict 结果：按策略只填对应数组，其余为空 */
export interface ConflictOutcome {
  /** strategy=skip 时被跳过的名字 */
  skip: string[];
  /** strategy=rename 时的改名映射（旧名 → 新名；无冲突的名字不进 Map） */
  renamed: Map<string, string>;
  /** strategy=overwrite 时被覆盖的名字 */
  overwritten: string[];
}

/**
 * 计算导入名与既有名的冲突处置（纯函数，不碰库）：
 * - skip：冲突 → 跳过（保留库中现有配置）
 * - rename：冲突 → 加 `-1` 后缀，仍冲突则 `-2`…直到不与「既有名、其他导入名、
 *   已分配的新名」碰撞（新名撞其他导入名同样会让 DB 主键冲突，故一并避开）
 * - overwrite：冲突 → 用导入内容覆盖
 *
 * 边界：同一批次内的重复导入名以首个为准（Map<old,new> 按旧名索引，无法表达
 * 同名多份的各自去向；调用方应保证导入列表内名字唯一，路由层会先去重）。
 */
export function applyImportConflict(
  existing: string[],
  incoming: string[],
  strategy: ImportStrategy,
): ConflictOutcome {
  const outcome: ConflictOutcome = { skip: [], renamed: new Map(), overwritten: [] };
  // taken = 已占用名：既有名起底，随处理推进纳入「本轮导入已定稿的名字」
  const taken = new Set(existing);
  // 导入名全集：rename 的新名不得与之相撞（否则落库时主键冲突）
  const incomingSet = new Set(incoming);

  const seen = new Set<string>();
  for (const name of incoming) {
    if (seen.has(name)) continue; // 批内重复名：首个定稿，后续忽略
    seen.add(name);

    if (!taken.has(name)) {
      taken.add(name); // 占位：同名再次出现时按冲突处理
      continue;
    }
    if (strategy === "skip") {
      outcome.skip.push(name);
      continue;
    }
    if (strategy === "overwrite") {
      outcome.overwritten.push(name);
      continue;
    }
    // rename：name-1、name-2 … 直到不撞 taken 与导入名全集
    let suffix = 1;
    let candidate = `${name}-${suffix}`;
    while (taken.has(candidate) || incomingSet.has(candidate)) {
      suffix += 1;
      candidate = `${name}-${suffix}`;
    }
    outcome.renamed.set(name, candidate);
    taken.add(candidate);
  }
  return outcome;
}
