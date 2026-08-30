import type Database from "better-sqlite3";
import { BUILTIN_DEFAULT_CONFIG } from "../../core/config";
import {
  defaultConfigSchema,
  modelSchema,
  NAMESPACE_PATTERN,
  type DefaultConfig,
  type ModelConfig,
} from "../../core/schemas";
import { ModelNameConflictError, isPrimaryKeyConflict } from "../modelErrors";

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

/** 命名空间行 + 聚合信息（M1 Task 12：设置页 / GET /api/v1/namespaces 数据源） */
export interface NamespaceMeta {
  name: string;
  /** ISO 8601 字符串 */
  createdAt: string;
  /** 该空间下的模型配置数 */
  modelCount: number;
}

export interface ModelRepo {
  /** 新建命名空间（重复调用幂等） */
  createNamespace(name: string): void;
  /** 全部命名空间，按名称排序 */
  listNamespaces(): string[];
  /**
   * 重命名命名空间（M1 Task 12）：一个事务内「插新行（沿用原 created_at）→
   * 批量 UPDATE 该空间全部 models.namespace（updated_at 一并刷新）→ 删旧行」。
   * 不直接改父键名：FK 开启时会让 models.namespace 中途悬空。源不存在抛错；
   * 目标重名交由调用方（服务层）前置检查。
   */
  renameNamespace(from: string, to: string): void;
  /** 删除命名空行（其下须无模型配置，守卫在服务层）；不存在抛错 */
  deleteNamespace(name: string): void;
  /** 全部命名空间 + 模型数聚合，按名称排序 */
  listNamespacesWithMeta(): NamespaceMeta[];

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
    listNamespacesWithMeta: db.prepare(`
      SELECT n.name AS name, n.created_at AS created_at,
             (SELECT COUNT(*) FROM models m WHERE m.namespace = n.name) AS model_count
      FROM namespaces n
      ORDER BY n.name
    `),
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
    // renameNamespace 三步的语句：FK 约束下不能直接改父键名（models.namespace
    // 立即悬空），改为「插新行（沿用原 created_at）→ 改模型归属 → 删旧行」，
    // 任何中间态都不违反外键，整体包在一个事务里
    insertNamespaceAs: db.prepare(`
      INSERT INTO namespaces(name, created_at)
      SELECT @to, created_at FROM namespaces WHERE name = @from
    `),
    renameNamespaceModels: db.prepare(
      "UPDATE models SET namespace = @to, updated_at = @ts WHERE namespace = @from",
    ),
    deleteNamespaceRow: db.prepare("DELETE FROM namespaces WHERE name = ?"),
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
        throw new Error(`命名空间非法（仅小写字母数字、点、下划线与连字符）: ${name}`);
      }
      stmt.insertNamespace.run(name, Date.now());
    },

    listNamespaces() {
      return (stmt.listNamespaces.all() as { name: string }[]).map((row) => row.name);
    },

    renameNamespace(from, to) {
      if (!NAMESPACE_PATTERN.test(from)) {
        throw new Error(`命名空间非法（仅小写字母数字、点、下划线与连字符）: ${from}`);
      }
      if (!NAMESPACE_PATTERN.test(to)) {
        throw new Error(`命名空间非法（仅小写字母数字、点、下划线与连字符）: ${to}`);
      }
      if (stmt.getNamespace.get(from) === undefined) {
        throw new Error(`命名空间不存在: ${from}`);
      }
      // 行改名 + 批量改模型归属同一事务：插新行（保留 created_at）→
      // 改模型指向 → 删旧行，FK 全程无悬空
      const now = Date.now();
      db.transaction(() => {
        stmt.insertNamespaceAs.run({ from, to });
        stmt.renameNamespaceModels.run({ from, to, ts: now });
        stmt.deleteNamespaceRow.run(from);
      })();
    },

    deleteNamespace(name) {
      if (stmt.getNamespace.get(name) === undefined) {
        throw new Error(`命名空间不存在: ${name}`);
      }
      stmt.deleteNamespaceRow.run(name);
    },

    listNamespacesWithMeta() {
      return (
        stmt.listNamespacesWithMeta.all() as {
          name: string;
          created_at: number;
          model_count: number;
        }[]
      ).map((row) => ({
        name: row.name,
        createdAt: iso(row.created_at),
        modelCount: row.model_count,
      }));
    },

    createModel(input) {
      const parsed = modelSchema.safeParse(input);
      if (!parsed.success) invalid("模型校验失败", parsed.error.issues);
      const model = parsed.data;

      const ns = stmt.getNamespace.get(model.namespace) as { name: string } | undefined;
      if (!ns) throw new Error(`命名空间不存在: ${model.namespace}`);

      const now = Date.now();
      // 主键冲突由 insert 兜底捕获而非先查后插——后者在并发 POST 下有 TOCTOU 窗口
      try {
        stmt.insertModel.run({ ...toColumns(model), created_at: now, updated_at: now });
      } catch (error) {
        if (isPrimaryKeyConflict(error)) throw new ModelNameConflictError(model.name);
        throw error;
      }
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
