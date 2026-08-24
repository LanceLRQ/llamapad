import { NextResponse } from "next/server";
import { groupRepoFiles } from "@/core/quant";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { listRepoFiles, resolveHfOptions } from "@/server/hf/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/hf/repos/:id/files（M2 Task 7）：下载向导「浏览文件」数据源。
 *
 * :id 为 URL encode 的 repo（如 bartowski%2FQwen3-32B-GGUF）；App Router 动态段
 * 已自动 decode，这里再做一次防御性解码（repo 名不含 %，双解码无破坏风险），
 * 兼容经中间层重复编码的请求。
 *
 * 流程：resolveHfOptions（镜像/Token/代理）→ listRepoFiles → groupRepoFiles →
 * `{ groups, hasGguf, total }`：
 * - groups 仅含 .gguf 分组（quant.ts 排除了其他扩展名）；hasGguf=false 时
 *   置空数组，UI 整页提示「仓库内没有 GGUF 文件」
 * - total 为仓库全部文件数（含 README/safetensors 等，供「找到 N 个文件」文案）
 *
 * 错误语义取舍——上游错误统一 502 包装 + message 透传：
 * listRepoFiles 已把 HF 404/401/403/429 与网络错误映射成面向用户的中文 message
 * （见 hf/client.ts 的 mapHfError），客户端按 502 + message 行内展示即可。不透传
 * 上游状态码的原因：本面板 API 的 404 约定是「面板资源不存在」（模型/任务等），
 * 这里缺失的是上游资源，透传 404 会让客户端把它误归入面板 404 分支；502（坏网关）
 * 语义即「上游取数失败」，具体原因全在 message 里（仓库不存在 / Token 无效 /
 * 限流 / 网络错误），UI 不需要按状态码细分。
 */

/** repo id 合法形态：一段或多段 `[A-Za-z0-9][A-Za-z0-9_.-]*`（HF 命名规则宽松子集，防注入） */
const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*(\/[A-Za-z0-9][A-Za-z0-9_.-]*)*$/;

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const { id } = await ctx.params;
  let repo = id;
  try {
    repo = decodeURIComponent(id);
  } catch {
    // 含非法 % 序列：按原值走后续格式校验（必然 400）
  }
  if (!REPO_PATTERN.test(repo)) {
    return NextResponse.json({ error: `仓库 ID 非法: ${id}` }, { status: 400 });
  }

  try {
    const files = await listRepoFiles(repo, await resolveHfOptions());
    const groups = groupRepoFiles(files);
    const hasGguf = groups.length > 0;
    return NextResponse.json({
      groups: hasGguf ? groups : [],
      hasGguf,
      total: files.length,
    });
  } catch (error) {
    // mapHfError 产出的中文 message 直接透传（向导行内展示）
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
