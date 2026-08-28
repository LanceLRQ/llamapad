import { NextResponse } from "next/server";
import { z } from "zod";
import { fromBashYaml, fromExportYaml } from "@/core/yamlIo";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { resolveModelFiles } from "@/server/fsScanner";
import { getPanelModelsRoot } from "@/server/locators";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/import/preview（T4，规格 §4）：导入预检，只解析不落库。
 *
 * body：`{ content: string, format: "llamapad" | "bash" }`——与 /api/v1/import
 * 共用同一对解析函数（fromExportYaml / fromBashYaml），不重复实现 YAML 语义。
 * 成功 200 `{ models: [{ name, gguf_file, mmproj_file, ggufMissing, mmprojMissing }], warnings }`：
 * - ggufMissing/mmprojMissing 用 resolveModelFiles 按面板视角的 models 根判定，
 *   与真正导入后 UI 展示"文件缺失"的判定同一套逻辑，预检结果与导入后所见一致
 * - mmproj_file 未配置时固定 mmprojMissing=false（没有要找的文件，谈不上缺失）
 * - 前端据此决定：全部命中直接导入；有缺失则展示重指表格，收集 remap 交给
 *   POST /api/v1/import
 *
 * 解析失败（YAML 语法 / schema 不符）与 /api/v1/import 同款处理：400，
 * message 带字段路径。
 */

const previewBodySchema = z.strictObject({
  content: z.string().min(1, "content 不能为空"),
  format: z.enum(["llamapad", "bash"]),
});

interface PreviewModel {
  name: string;
  gguf_file: string;
  mmproj_file: string | null;
  ggufMissing: boolean;
  mmprojMissing: boolean;
}

/**
 * resolveModelFiles 对含 ".." 的路径会抛错（防逃逸 models 根）——导入内容是
 * 用户粘贴的自由文本，理论上可以写出这种路径。预检的语气是"帮忙找问题"而非
 * "校验安全性"（真正落库时 modelSchema 仍会照常拦截非法值），此处按"找不到"
 * 处理即可，不该因为一条脏路径让整个预检直接 500。
 */
function isMissing(root: string, relPath: string | undefined): boolean {
  if (relPath === undefined) return false;
  try {
    return resolveModelFiles(root, relPath).missing;
  } catch {
    return true;
  }
}

export async function POST(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const body = await req.json().catch(() => null);
  const parsed = previewBodySchema.safeParse(body);
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

  let models: { name: string; gguf_file: string; mmproj_file?: string }[];
  let warnings: string[];
  try {
    if (format === "llamapad") {
      models = fromExportYaml(content).models;
      warnings = [];
    } else {
      const parsedBash = fromBashYaml(content);
      models = [parsedBash.model];
      warnings = parsedBash.warnings;
    }
  } catch (error) {
    // YAML 解析失败 / schema 校验失败（message 带字段路径）→ 400，与 /api/v1/import 一致
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }

  const root = getPanelModelsRoot();
  const preview: PreviewModel[] = models.map((m) => ({
    name: m.name,
    gguf_file: m.gguf_file,
    mmproj_file: m.mmproj_file ?? null,
    ggufMissing: isMissing(root, m.gguf_file),
    mmprojMissing: isMissing(root, m.mmproj_file),
  }));

  return NextResponse.json({ models: preview, warnings });
}
