import { NextResponse } from "next/server";
import { z } from "zod";
import { fromBashYaml, fromExportYaml } from "@/core/yamlIo";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { applyDefaults, importModels } from "@/server/importService";
import { maybeAutoSnapshot } from "@/server/snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/import（M2 Task 8）：单 YAML 文本导入。
 *
 * body：`{ content: string, format: "llamapad" | "bash", strategy?: "skip"|"rename"|"overwrite" }`
 * - format=llamapad：fromExportYaml（三段全量）→ defaults 一并恢复、模型回原
 *   命名空间（缺失空间自动补建）
 * - format=bash：fromBashYaml（llama-launcher 单模型格式）→ 落 main 空间；
 *   jinja / no_mmap 等独有字段以 warnings 透出
 * - strategy 缺省 skip（保守：不动既有配置）
 *
 * 只收单文件文本（zip 恢复 = 解开后逐文件导入，见 export 路由的取舍说明；
 * zip 直传导入为后续增强）。解析/校验失败 400（message 带字段路径）；
 * 成功 200 `{ imported, skipped, renamed, overwritten, warnings, defaultsApplied }`。
 */

const importBodySchema = z.strictObject({
  content: z.string().min(1, "content 不能为空"),
  format: z.enum(["llamapad", "bash"]),
  strategy: z.enum(["skip", "rename", "overwrite"]).optional(),
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
  const { content, format } = parsed.data;
  const strategy = parsed.data.strategy ?? "skip";

  const db = getDb();
  try {
    if (format === "llamapad") {
      const bundle = fromExportYaml(content);
      // 全量格式：defaults 一并恢复（缺失空间由 importModels 自动补建）
      applyDefaults(db, bundle.defaults);
      const outcome = importModels(db, bundle.models, strategy);
      recordEvent(
        "config.import",
        `导入 llamapad 配置：${outcome.imported.length} 个模型` +
          (outcome.skipped.length > 0 ? `，跳过 ${outcome.skipped.join("、")}` : ""),
      );
      // 配置已变更：自动快照（同步写盘，毫秒级；失败仅 warn 不影响导入结果）
      maybeAutoSnapshot(db);
      return NextResponse.json({ ...outcome, defaultsApplied: true });
    }

    const { model, warnings } = fromBashYaml(content);
    const outcome = importModels(db, [model], strategy);
    recordEvent("config.import", `导入 bash 模型 ${model.name}（落 main 空间）`);
    maybeAutoSnapshot(db);
    return NextResponse.json({ ...outcome, warnings: [...warnings, ...outcome.warnings], defaultsApplied: false });
  } catch (error) {
    // YAML 解析失败 / schema 校验失败（message 带字段路径）→ 400
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
