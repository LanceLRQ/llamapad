import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { createFolder, FolderError, folderErrorStatus } from "@/server/folders";
import { scanTree } from "@/server/fsScanner";
import { getPanelModelsRoot } from "@/server/locators";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/folders（阶段 4 D1）：全部目录的相对路径列表（含空串代表
 * 根——只在根目录确有直接文件时才会出现，见 fsScanner.walkTree 注释），
 * 供向导「存放位置」下拉用。不复用 GET /api/v1/files/tree：那个接口为了
 * 文件页的完整表格连每个文件的 size/mtime/refs 都要展开，向导只要一份
 * 目录名单，没必要为此多算一遍全部文件的引用计数。
 */
export async function GET(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const folders = scanTree(getPanelModelsRoot()).map((g) => g.folder);
  return NextResponse.json({ folders });
}

/**
 * POST /api/v1/folders（阶段 3a C5 服务层部分）：在 models 根下新建一个目录
 * （可多级，一次建好）。
 *
 * 不调用 maybeAutoSnapshot：新建空目录是纯文件系统操作，不触碰任何模型
 * 配置（没有 gguf_file/mmproj_file 被重写），没有 DB 状态可快照——这点上
 * 更像 POST /api/v1/files/bulk-delete（同样是纯 fs 操作，同样不快照），
 * 不是 folders/rename 那种"必然伴随引用重写"的场景。
 *
 * body：`{ path: string }`（相对 models 根，可含多级目录段）。
 * 错误响应 `{ error: CODE, message }`（与 folders/rename 同款契约）：
 * INVALID_NAME/CONFLICT → 400。
 *
 * UI 入口（面包屑、新建文件夹按钮）是下一批的事，本 route 只提供服务层能力。
 */
const createBodySchema = z.strictObject({
  path: z.string().min(1, "path 不能为空"),
});

export async function POST(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const body = await req.json().catch(() => null);
  const parsed = createBodySchema.safeParse(body);
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

  try {
    const result = createFolder({ modelsRoot: getPanelModelsRoot() }, parsed.data);

    // kind 取 "file." 前缀，理由同 folders/rename route：webhooks-card.tsx 的
    // KIND_GROUPS 按前缀分组订阅，新建文件夹同样是文件页的一次结构性操作。
    getDb()
      .prepare("INSERT INTO events(ts, kind, message) VALUES (?, ?, ?)")
      .run(Date.now(), "file.folder_create", `新建文件夹 ${result.path}`);

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof FolderError) {
      return NextResponse.json(
        { error: error.code, message: error.message },
        { status: folderErrorStatus(error.code) },
      );
    }
    throw error;
  }
}
