import { NextResponse } from "next/server";
import JSZip from "jszip";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { toExportYaml } from "@/core/yamlIo";
import type { DefaultConfig, ModelConfig } from "@/core/schemas";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { createModelRepo, type StoredModel } from "@/server/repo/models";
import { buildExportYaml, getExportDir } from "@/server/snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/export（M2 Task 8）：配置导出。
 *
 * - 全集（无参数）：jszip 打包 `llamapad.yaml`（defaults+models+namespaces 三段）
 *   + `models/<name>.yaml`（每模型一份自包含单模型导出，灾备恢复时可逐文件
 *   粘贴进导入表单），写 `<configDir>/export/llamapad-<ts>.zip` → 200 {path, bytes}
 * - ?model=name：单模型 → 纯 YAML 文本响应（同三段格式、仅含该模型，
 *   Content-Disposition 附件下载；可直接粘贴回导入表单往返）
 *
 * zip 导入的取舍：本路由只产出 zip；导入端（/api/v1/import）只收单 YAML 文本，
 * zip 恢复 = 解开后把 llamapad.yaml（或逐个 models/*.yaml）粘贴导入——灾备
 * 场景低频且人工可控，比「二进制 base64 提交 + 服务端解包 + 部分失败回滚」
 * 简单得多；后续增强再补 zip 直传导入。
 */

/** zip 文件名时间戳：ISO 基本格式（20260824T151405Z），文件名安全 */
function zipTimestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
}

/** 单模型自包含导出文本（复用 toExportYaml，格式与全集/导入完全一致） */
function singleModelYaml(
  defaults: DefaultConfig,
  model: StoredModel | ModelConfig,
  namespaces: string[],
): string {
  // StoredModel 多出的时间戳键由 toExportYaml 内的 schema 剥离
  return toExportYaml({ defaults, models: [model], namespaces });
}

export async function POST(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const db = getDb();
  const repo = createModelRepo(db);
  const defaults = repo.getDefaultConfig();
  const models = repo.listModels();
  const namespaces = repo.listNamespaces();

  const modelName = new URL(req.url).searchParams.get("model");
  if (modelName !== null) {
    const model = repo.getModel(modelName);
    if (!model) {
      return NextResponse.json({ error: `模型不存在: ${modelName}` }, { status: 404 });
    }
    const yaml = singleModelYaml(defaults, model, namespaces);
    return new Response(yaml, {
      status: 200,
      headers: {
        "Content-Type": "application/yaml; charset=utf-8",
        "Content-Disposition": `attachment; filename="model-${modelName}.yaml"`,
      },
    });
  }

  const zip = new JSZip();
  zip.file("llamapad.yaml", buildExportYaml(db));
  for (const model of models) {
    zip.file(`models/${model.name}.yaml`, singleModelYaml(defaults, model, namespaces));
  }
  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });

  const dir = getExportDir();
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `llamapad-${zipTimestamp()}.zip`);
  writeFileSync(file, buffer);

  return NextResponse.json({ path: file, bytes: buffer.byteLength });
}
