import { NextResponse } from "next/server";
import { z } from "zod";
import path from "node:path";
import type { DefaultConfig, ModelConfig } from "@/core/schemas";
import { fromBashDefaultYaml, fromBashYaml } from "@/core/yamlIo";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { applyDefaults, importModels, type ImportOutcome } from "@/server/importService";
import { maybeAutoSnapshot } from "@/server/snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/migrate/bash（M2 Task 8）：bash 前身（llama-launcher）批量迁移。
 *
 * body：`{ files: [{ name, content }], strategy? }`——把 configs 目录下的
 * default.yaml 与 configs/models/*.yaml 逐个读成文本提交（zip 版后续增强；
 * 文件数量级是个位数，逐文件粘贴成本可控且直观）：
 * - basename 为 default.yaml 的文件 → fromBashDefaultYaml（gpu_devices→gpu、
 *   缺字段内置默认补齐）→ setDefaultConfig 覆盖（多份时最后一份生效）
 * - 其余文件 → fromBashYaml → 落 main 空间，同冲突三策略批量处理
 * - bash 独有字段（jinja / no_mmap）等以 warnings 透出（带文件名前缀）
 *
 * 解析/校验失败 400（message 带字段路径与文件名）；成功 200 同 import 的
 * 结果结构 + defaultsApplied。
 */

const migrateBodySchema = z.strictObject({
  files: z
    .array(
      z.strictObject({
        name: z.string().min(1, "name 不能为空"),
        content: z.string().min(1, "content 不能为空"),
      }),
    )
    .min(1, "files 不能为空"),
  strategy: z.enum(["skip", "rename", "overwrite"]).optional(),
});

/** 追加一条事件（与 models 路由的 recordEvent 同款写入方式） */
function recordEvent(kind: string, message: string): void {
  getDb()
    .prepare("INSERT INTO events(ts, kind, message) VALUES (?, ?, ?)")
    .run(Date.now(), kind, message);
}

/** 解析一个 bash 文件：default.yaml → defaults；模型 yaml → ModelConfig */
function parseBashFile(file: { name: string; content: string }):
  | { kind: "defaults"; defaults: DefaultConfig; warnings: string[] }
  | { kind: "model"; model: ModelConfig; warnings: string[] } {
  const fail = (error: unknown): never => {
    throw new Error(`${file.name}: ${(error as Error).message}`);
  };
  try {
    if (path.basename(file.name) === "default.yaml") {
      const parsed = fromBashDefaultYaml(file.content);
      return {
        kind: "defaults",
        defaults: parsed.defaults,
        warnings: parsed.warnings.map((w) => `${file.name}: ${w}`),
      };
    }
    const parsed = fromBashYaml(file.content);
    return {
      kind: "model",
      model: parsed.model,
      warnings: parsed.warnings.map((w) => `${file.name}: ${w}`),
    };
  } catch (error) {
    return fail(error);
  }
}

export async function POST(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const body = await req.json().catch(() => null);
  const parsedBody = migrateBodySchema.safeParse(body);
  if (!parsedBody.success) {
    return NextResponse.json(
      {
        error: "invalid_body",
        issues: parsedBody.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
      { status: 400 },
    );
  }
  const strategy = parsedBody.data.strategy ?? "skip";

  const db = getDb();
  try {
    const warnings: string[] = [];
    const models: ModelConfig[] = [];
    let defaultsToApply: DefaultConfig | null = null;

    for (const file of parsedBody.data.files) {
      const parsed = parseBashFile(file);
      warnings.push(...parsed.warnings);
      if (parsed.kind === "defaults") defaultsToApply = parsed.defaults; // 多份时最后一份生效
      else models.push(parsed.model);
    }

    let defaultsApplied = false;
    if (defaultsToApply) {
      applyDefaults(db, defaultsToApply);
      defaultsApplied = true;
    }
    const outcome: ImportOutcome = models.length > 0 ? importModels(db, models, strategy) : {
      imported: [],
      skipped: [],
      renamed: [],
      overwritten: [],
      warnings: [],
    };

    recordEvent(
      "config.migrate",
      `bash 迁移：${outcome.imported.length} 个模型` + (defaultsApplied ? " + 默认配置" : ""),
    );
    maybeAutoSnapshot(db); // 配置已变更：自动快照（失败仅 warn）
    return NextResponse.json({ ...outcome, warnings: [...warnings, ...outcome.warnings], defaultsApplied });
  } catch (error) {
    // 单文件解析/校验失败（message 已带文件名与字段路径）→ 400
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
