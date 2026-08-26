import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { getRuntimeService } from "@/server/locators";
import { createModelRepo } from "@/server/repo/models";
import { downloadSchema, overridesSchema } from "@/core/schemas";
import { maybeAutoSnapshot } from "@/server/snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * /api/v1/models/:name（M1 Task 8）：单模型详情 / 编辑 / 删除，薄壳调 repo + runtime。
 *
 * - GET：模型详情（含 overrides / download 反序列化结果）；不存在 404
 * - PUT：可编辑字段校验（display_name / namespace / gguf_file / mmproj_file / download / overrides）
 *   → 命名空间须已存在 → repo.updateModel + events `model.update`。
 *   运行中**允许保存**（UX P0 后放开，原 M1 一刀切 409）：容器参数不热更新，
 *   改动的"重启后生效"语义由 configStale 漂移提示承接（modelsView 比对
 *   updated_at > startedAt，模型行徽标 + 编辑页横幅）
 * - DELETE：运行中 409（删配置会留下无主容器）；否则仅删配置（DB 行，GGUF 文件保留）+ events `model.delete`
 *
 * 校验失败 400，issues[].path 携带字段路径（与 POST /models 同契约），
 * 编辑表单按 path 把错误映射回对应输入框。gguf 路径与 namespace 的规则
 * 与 core/schemas.ts 一致（后者未导出子 schema，此处内联同款正则；
 * repo.updateModel 内部仍会用完整 modelSchema 复核一遍）。
 */

const GGUF_PATH_PATTERN = /^[^/\s:][^:\s]*\.gguf$/;
const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** PUT body：全字段可选（未提供 = 不修改）；mmproj_file 传 null 显式清空 */
const putBodySchema = z.strictObject({
  display_name: z.string().min(1, "display_name 不能为空").optional(),
  namespace: z
    .string()
    .regex(NAMESPACE_PATTERN, "namespace 只允许小写字母数字与连字符")
    .optional(),
  gguf_file: z
    .string()
    .regex(GGUF_PATH_PATTERN, "gguf 路径必须是相对 models 根、以 .gguf 结尾的路径")
    .optional(),
  mmproj_file: z
    .union([
      z.string().regex(GGUF_PATH_PATTERN, "mmproj 路径必须是相对 models 根、以 .gguf 结尾的路径"),
      z.null(),
    ])
    .optional(),
  /**
   * 下载源：传对象改配置，传 null 显式清空（与 mmproj_file 的 null 语义一致）。
   * 用 nullable() 而非 z.union([downloadSchema, z.null()])：discriminatedUnion
   * 分支匹配失败时，union 包一层会把字段级路径/message 糊成笼统的顶层 invalid_union，
   * 与本文件顶部 JSDoc 承诺的「issues[].path 携带字段路径」契约相悖；nullable() 保留
   * discriminatedUnion 原生的字段级报错，且与 POST /models（modelSchema 里
   * download: downloadSchema.optional()，未套 union）行为一致。
   */
  download: downloadSchema.nullable().optional(),
  overrides: overridesSchema.optional(),
});

function notFound(name: string): NextResponse {
  return NextResponse.json({ error: `模型不存在: ${name}` }, { status: 404 });
}

/** 追加一条事件（与 runtime.ts 的 record 同款写入方式） */
function recordEvent(kind: string, message: string): void {
  getDb()
    .prepare("INSERT INTO events(ts, kind, message) VALUES (?, ?, ?)")
    .run(Date.now(), kind, message);
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ name: string }> },
): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const { name } = await ctx.params;
  const model = createModelRepo(getDb()).getModel(name);
  if (!model) return notFound(name);
  return NextResponse.json(model);
}

export async function PUT(
  req: Request,
  ctx: { params: Promise<{ name: string }> },
): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const { name } = await ctx.params;
  const db = getDb();
  const repo = createModelRepo(db);
  if (!repo.getModel(name)) return notFound(name);

  const body = await req.json().catch(() => null);
  const parsed = putBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "invalid_patch",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
      { status: 400 },
    );
  }
  const patch = parsed.data;

  if (patch.namespace !== undefined && !repo.listNamespaces().includes(patch.namespace)) {
    return NextResponse.json({ error: `命名空间不存在: ${patch.namespace}` }, { status: 400 });
  }

  // 运行中允许保存（见文件头注释：漂移语义由 configStale 承接，不再一刀切 409）

  try {
    const updated = repo.updateModel(name, patch);
    const changed = Object.entries(patch)
      .filter(([, value]) => value !== undefined)
      .map(([key]) => key);
    recordEvent("model.update", `更新模型 ${name}（${changed.join("、")}）`);
    maybeAutoSnapshot(db); // 配置变更点：自动快照（同步写盘毫秒级；失败仅 warn）
    return NextResponse.json(updated);
  } catch (error) {
    // repo 内 modelSchema 复核失败（message 含字段路径）等业务性错误 → 400
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ name: string }> },
): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const { name } = await ctx.params;
  if (!createModelRepo(getDb()).getModel(name)) return notFound(name);

  const status = await getRuntimeService().getRuntimeStatus();
  if (status.running?.model === name) {
    return NextResponse.json({ error: "模型运行中，禁止删除" }, { status: 409 });
  }

  createModelRepo(getDb()).deleteModel(name);
  recordEvent("model.delete", `删除模型 ${name}（仅删配置，文件保留）`);
  maybeAutoSnapshot(getDb()); // 配置变更点：自动快照（同步写盘毫秒级；失败仅 warn）
  return NextResponse.json({ ok: true });
}
