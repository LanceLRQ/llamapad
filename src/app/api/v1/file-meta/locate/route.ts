import { NextResponse } from "next/server";
import { z } from "zod";
import { ggufPathSchema } from "@/core/schemas";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { FileMetaError, locateCandidates } from "@/server/fileMeta";
import { getPanelModelsRoot } from "@/server/locators";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/file-meta/locate：自动寻找（设计 §3.4），返回候选清单，不落库。
 *
 * body：`{ path: string }`（file_meta 条目的 path，即模型配置里的 gguf_file/
 * mmproj_file 值）。响应：`{ candidates: LocateCandidate[] }`——候选池是 models
 * 树中未被任何配置引用的文件，先比采样哈希、命中后比完整哈希确认，是否落库
 * 交给用户在确认框里点「重链」后另调 relink（本接口刻意不做静默改写）。
 */
const bodySchema = z.strictObject({ path: ggufPathSchema });

export async function POST(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const body = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
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
    const candidates = await locateCandidates(getDb(), getPanelModelsRoot(), parsed.data.path);
    return NextResponse.json({ candidates });
  } catch (error) {
    if (error instanceof FileMetaError) {
      const status = error.code === "NOT_FOUND" ? 404 : 400;
      return NextResponse.json({ error: error.message }, { status });
    }
    throw error;
  }
}
