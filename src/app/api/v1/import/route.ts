import { NextResponse } from "next/server";
import { z } from "zod";
import { fromBashYaml, fromExportYaml } from "@/core/yamlIo";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { applyDefaults, importModels, importPresets, importRepos } from "@/server/importService";
import { getPanelModelsRoot } from "@/server/locators";
import { maybeAutoSnapshot } from "@/server/snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/import（M2 Task 8；T4 增 remap）：单 YAML 文本导入。
 *
 * body：`{ content: string, format: "llamapad" | "bash", strategy?: "skip"|"rename"|"overwrite", remap?: ImportRemap }`
 * - format=llamapad：fromExportYaml（全量五段）→ defaults 一并恢复、模型回原
 *   命名空间（缺失空间自动补建）、仓库档案一并恢复（I8 修复：此前 repos 段
 *   写出来无人读，换机导入会静默丢光档案登记，磁盘目录全变孤儿）——已登记
 *   的 (baseDir, repo) 降级为跳过，不让整次导入失败，计数并入响应与事件文案；
 *   参数预设一并恢复（presets 段可选，同名跳过不覆盖，坏条目进 failed 不阻断
 *   整批，结果并入响应与事件文案，见 importService.importPresets）
 * - format=bash：fromBashYaml（llama-launcher 单模型格式）→ 落 main 空间；
 *   jinja / no_mmap 等独有字段以 warnings 透出（不含仓库档案，bash 前身无此概念）
 * - strategy 缺省 skip（保守：不动既有配置）
 * - remap（可选，规格 §4）：key = YAML 中的模型名，值为要写入的 gguf_file /
 *   mmproj_file 新路径，用于把导入的模型重指到本机已有的文件——由
 *   POST /api/v1/import/preview 的结果驱动，前端只在预检发现文件缺失时才带上；
 *   不传时行为与现状逐字一致（importModels 内部处理，见其头注释）
 *
 * 只收单文件文本（zip 恢复 = 解开后逐文件导入，见 export 路由的取舍说明；
 * zip 直传导入为后续增强）。解析/校验失败 400（message 带字段路径，remap 的
 * 非法路径同样在此返回，字段路径形如 `remap.<模型名>.gguf_file`）；
 * 成功 200 `{ imported, skipped, renamed, overwritten, warnings, defaultsApplied }`；
 * format=llamapad 额外带 `repos: { imported: string[], skipped: string[] }`
 * （仓库档案恢复结果，用 targetDir 标识，见 importService.importRepos）与
 * `presets: { created: string[], skipped: string[], failed: {name, error}[] }`
 * （参数预设恢复结果，见 importService.importPresets）——
 * bash 格式无仓库档案概念，响应中不含该字段。
 */

const importRemapSchema = z.record(
  z.string(),
  z.strictObject({ gguf_file: z.string().optional(), mmproj_file: z.string().optional() }),
);

const importBodySchema = z.strictObject({
  content: z.string().min(1, "content 不能为空"),
  format: z.enum(["llamapad", "bash"]),
  strategy: z.enum(["skip", "rename", "overwrite"]).optional(),
  remap: importRemapSchema.optional(),
});

/** 追加一条事件（与 models 路由的 recordEvent 同款写入方式） */
function recordEvent(kind: string, message: string): void {
  getDb()
    .prepare("INSERT INTO events(ts, kind, message) VALUES (?, ?, ?)")
    .run(Date.now(), kind, message);
}

export async function POST(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const body = await req.json().catch(() => null);
  const parsed = importBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "invalid_body",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
      { status: 400 },
    );
  }
  const { content, format, remap } = parsed.data;
  const strategy = parsed.data.strategy ?? "skip";

  const db = getDb();
  try {
    if (format === "llamapad") {
      const bundle = fromExportYaml(content);
      // 三步包一个事务（缺陷 3 修复）：任一步失败要整体回滚，不能落成
      // "返回 400 但一半已落库"——此前 importRepos 若因非法条目抛错
      // （已被上面的前置校验拦掉大半，但仍以防御姿态包一层），defaults
      // 与全部模型已经进库，用户看到失败后重试还会再走一遍冲突处置。
      // db.transaction() 返回的是函数，必须调用；better-sqlite3 支持
      // 嵌套事务（SAVEPOINT）——但这里被调用的 applyDefaults/importModels/
      // importRepos/importPresets 内部均未自建事务（各自只是若干条独立
      // INSERT/UPDATE），不存在嵌套冲突。
      const { outcome, reposOutcome, presetsOutcome } = db.transaction(() => {
        // 全量格式：defaults 一并恢复（缺失空间由 importModels 自动补建）
        applyDefaults(db, bundle.defaults);
        const outcome = importModels(db, bundle.models, strategy, remap);
        // 仓库档案（I8 修复）：repos 段可选，早于该字段的导出文件没有，兼容传空数组
        const reposOutcome = importRepos(db, getPanelModelsRoot(), bundle.repos ?? []);
        // 参数预设：presets 段可选，早于该字段的导出文件没有（undefined 当空批）
        const presetsOutcome = importPresets(db, bundle.presets);
        return { outcome, reposOutcome, presetsOutcome };
      })();
      recordEvent(
        "config.import",
        `导入 llamapad 配置：${outcome.imported.length} 个模型` +
          (outcome.skipped.length > 0 ? `，跳过 ${outcome.skipped.join("、")}` : "") +
          `，${reposOutcome.imported.length} 份仓库档案` +
          (reposOutcome.skipped.length > 0 ? `（跳过 ${reposOutcome.skipped.length} 份已登记）` : "") +
          `，${presetsOutcome.created.length} 条参数预设` +
          (presetsOutcome.skipped.length + presetsOutcome.failed.length > 0
            ? `（跳过 ${presetsOutcome.skipped.length} 条同名、失败 ${presetsOutcome.failed.length} 条）`
            : ""),
      );
      // 配置已变更：自动快照（同步写盘，毫秒级；失败仅 warn 不影响导入结果）
      maybeAutoSnapshot(db);
      return NextResponse.json({
        ...outcome,
        repos: reposOutcome,
        presets: presetsOutcome,
        defaultsApplied: true,
      });
    }

    const { model, warnings } = fromBashYaml(content);
    const outcome = importModels(db, [model], strategy, remap);
    recordEvent("config.import", `导入 bash 模型 ${model.name}（落 main 空间）`);
    maybeAutoSnapshot(db);
    return NextResponse.json({ ...outcome, warnings: [...warnings, ...outcome.warnings], defaultsApplied: false });
  } catch (error) {
    // YAML 解析失败 / schema 校验失败（message 带字段路径）→ 400
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
