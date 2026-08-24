import type Database from "better-sqlite3";
import { BUILTIN_DEFAULT_CONFIG } from "../../core/config";
import {
  defaultConfigSchema,
  modelSchema,
  type DefaultConfig,
  type ModelConfig,
} from "../../core/schemas";

/**
 * 模型 / 命名空间 / settings 仓储（M0 Task 5）
 *
 * - 工厂 createModelRepo(db)：内部幂等地确保 main 命名空间存在
 * - 行 ↔ ModelConfig 的序列化在 repo 内完成：overrides / download 存 JSON 文本，
 *   可选列（mmproj_file / download）以 NULL 表示缺省
 * - 全部操作走 prepared statements
 * - 写入前 zod 校验；错误 message 拼接 issue 的 path.join(".")，带字段路径透出
 */

/** settings 表中默认配置的键 */
const DEFAULT_CONFIG_KEY = "default_config";

/** 与 schemas.ts 的 namespaceSchema 同规则（后者未导出，此处内联以校验入参） */
const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** 出入库的模型：ModelConfig + 时间戳（ISO 8601 字符串） */
export type StoredModel = ModelConfig & { created_at: string; updated_at: string };

/**
 * updateModel 可修改的字段（name 为主键不可改）。
 * M1 Task 8 起支持 namespace 变更（仅改分组归属，不移动文件）；
 * 可选列 mmproj_file / download 传 null 表示显式清空（存 NULL），
 * undefined 表示"未提供不动"（与必填字段的省略语义一致）。
 */
export type ModelPatch = Partial<
  Pick<ModelConfig, "display_name" | "namespace" | "gguf_file" | "overrides">
> & {
  mmproj_file?: ModelConfig["mmproj_file"] | null;
  download?: ModelConfig["download"] | null;
};

export interface ModelRepo {
  /** 新建命名空间（重复调用幂等） */
  createNamespace(name: string): void;
  /** 全部命名空间，按名称排序 */
  listNamespaces(): string[];

  createModel(input: ModelConfig): StoredModel;
  getModel(name: string): StoredModel | null;
  /** 全部或按命名空间过滤的模型，按名称排序 */
  listModels(namespace?: string): StoredModel[];
  updateModel(name: string, patch: ModelPatch): StoredModel;
  deleteModel(name: string): void;

  /** 写入默认配置（先 schema 校验，失败抛含字段路径的 Error） */
  setDefaultConfig(config: DefaultConfig): void;
  /** 读取默认配置；未设置时返回内置默认值的独立副本，库中损坏时抛错不静默 */
  getDefaultConfig(): DefaultConfig;
}

type ModelRow = {
  name: string;
  display_name: string;
  namespace: string;
  gguf_file: string;
  mmproj_file: string | null;
  download: string | null;
  overrides: string;
  created_at: number;
  updated_at: number;
};

/** zod 校验失败 → message 含字段路径（zod 4：issue.path.join(".")）的 Error */
function invalid(what: string, issues: { path: PropertyKey[]; message: string }[]): never {
  const detail = issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
  throw new Error(`${what}: ${detail}`);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function createModelRepo(db: Database.Database): ModelRepo {
  const stmt = {
    insertNamespace: db.prepare(
      "INSERT OR IGNORE INTO namespaces(name, created_at) VALUES (?, ?)",
    ),
    listNamespaces: db.prepare("SELECT name FROM namespaces ORDER BY name"),
    getNamespace: db.prepare("SELECT name FROM namespaces WHERE name = ?"),
    insertModel: db.prepare(`
      INSERT INTO models(
        name, display_name, namespace, gguf_file, mmproj_file, download, overrides,
        created_at, updated_at
      ) VALUES (
        @name, @display_name, @namespace, @gguf_file, @mmproj_file, @download, @overrides,
        @created_at, @updated_at
      )
    `),
    getModel: db.prepare("SELECT * FROM models WHERE name = ?"),
    listModels: db.prepare("SELECT * FROM models ORDER BY name"),
    listModelsByNamespace: db.prepare("SELECT * FROM models WHERE namespace = ? ORDER BY name"),
    updateModel: db.prepare(`
      UPDATE models
      SET display_name = @display_name, namespace = @namespace, gguf_file = @gguf_file,
          mmproj_file = @mmproj_file, download = @download, overrides = @overrides,
          updated_at = @updated_at
      WHERE name = @name
    `),
    deleteModel: db.prepare("DELETE FROM models WHERE name = ?"),
    getSetting: db.prepare("SELECT value FROM settings WHERE key = ?"),
    setSetting: db.prepare(`
      INSERT INTO settings(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `),
  };

  // 首次（及每次）构造时幂等确保 main 命名空间存在
  stmt.insertNamespace.run("main", Date.now());

  function rowToModel(row: ModelRow): StoredModel {
    let overrides: ModelConfig["overrides"];
    try {
      overrides = JSON.parse(row.overrides) as ModelConfig["overrides"];
    } catch (error) {
      throw new Error(`模型 ${row.name} 的 overrides 损坏: ${(error as Error).message}`);
    }
    let download: ModelConfig["download"];
    if (row.download !== null) {
      try {
        download = JSON.parse(row.download) as ModelConfig["download"];
      } catch (error) {
        throw new Error(`模型 ${row.name} 的 download 损坏: ${(error as Error).message}`);
      }
    }
    return {
      name: row.name,
      display_name: row.display_name,
      namespace: row.namespace,
      gguf_file: row.gguf_file,
      mmproj_file: row.mmproj_file ?? undefined,
      download,
      overrides,
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
    };
  }

  function getModel(name: string): StoredModel | null {
    const row = stmt.getModel.get(name) as ModelRow | undefined;
    return row ? rowToModel(row) : null;
  }

  function toColumns(model: ModelConfig) {
    return {
      name: model.name,
      display_name: model.display_name,
      namespace: model.namespace,
      gguf_file: model.gguf_file,
      mmproj_file: model.mmproj_file ?? null,
      download: model.download ? JSON.stringify(model.download) : null,
      overrides: JSON.stringify(model.overrides ?? {}),
    };
  }

  return {
    createNamespace(name) {
      if (!NAMESPACE_PATTERN.test(name)) {
        throw new Error(`命名空间非法（仅小写字母数字与连字符）: ${name}`);
      }
      stmt.insertNamespace.run(name, Date.now());
    },

    listNamespaces() {
      return (stmt.listNamespaces.all() as { name: string }[]).map((row) => row.name);
    },

    createModel(input) {
      const parsed = modelSchema.safeParse(input);
      if (!parsed.success) invalid("模型校验失败", parsed.error.issues);
      const model = parsed.data;

      const ns = stmt.getNamespace.get(model.namespace) as { name: string } | undefined;
      if (!ns) throw new Error(`命名空间不存在: ${model.namespace}`);

      const now = Date.now();
      stmt.insertModel.run({ ...toColumns(model), created_at: now, updated_at: now });
      return { ...model, created_at: iso(now), updated_at: iso(now) };
    },

    getModel,

    listModels(namespace) {
      const rows =
        namespace === undefined
          ? (stmt.listModels.all() as ModelRow[])
          : (stmt.listModelsByNamespace.all(namespace) as ModelRow[]);
      return rows.map(rowToModel);
    },

    updateModel(name, patch) {
      const existing = getModel(name);
      if (!existing) throw new Error(`模型不存在: ${name}`);

      // 显式传入 undefined 的字段视为"未提供"，不覆盖已有值
      const provided: Record<string, unknown> = Object.fromEntries(
        Object.entries(patch).filter(([, value]) => value !== undefined),
      );
      // 可选列的 null 语义：显式清空（合并候选置 undefined → schema optional 通过 → 存 NULL）
      if (provided.mmproj_file === null) provided.mmproj_file = undefined;
      if (provided.download === null) provided.download = undefined;
      const parsed = modelSchema.safeParse({ ...existing, ...provided });
      if (!parsed.success) invalid("模型校验失败", parsed.error.issues);
      const model = parsed.data;

      const ns = stmt.getNamespace.get(model.namespace) as { name: string } | undefined;
      if (!ns) throw new Error(`命名空间不存在: ${model.namespace}`);

      const now = Date.now();
      stmt.updateModel.run({ ...toColumns(model), name, updated_at: now });
      return { ...model, created_at: existing.created_at, updated_at: iso(now) };
    },

    deleteModel(name) {
      stmt.deleteModel.run(name);
    },

    setDefaultConfig(config) {
      const parsed = defaultConfigSchema.safeParse(config);
      if (!parsed.success) invalid("默认配置校验失败", parsed.error.issues);
      stmt.setSetting.run(DEFAULT_CONFIG_KEY, JSON.stringify(parsed.data));
    },

    getDefaultConfig() {
      const row = stmt.getSetting.get(DEFAULT_CONFIG_KEY) as { value: string } | undefined;
      if (!row) return structuredClone(BUILTIN_DEFAULT_CONFIG);

      let raw: unknown;
      try {
        raw = JSON.parse(row.value);
      } catch (error) {
        throw new Error(
          `settings.${DEFAULT_CONFIG_KEY} 损坏（JSON 解析失败）: ${(error as Error).message}`,
        );
      }
      const parsed = defaultConfigSchema.safeParse(raw);
      if (!parsed.success) invalid(`settings.${DEFAULT_CONFIG_KEY} 校验失败`, parsed.error.issues);
      return parsed.data;
    },
  };
}
