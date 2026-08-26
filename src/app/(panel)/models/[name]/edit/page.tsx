import { notFound } from "next/navigation";

import { resolveModelFiles } from "@/server/fsScanner";
import { getDb } from "@/server/db";
import { getPanelModelsRoot, getRuntimeService } from "@/server/locators";
import { decorateRuntimeStatus } from "@/server/modelsView";
import { createModelRepo } from "@/server/repo/models";
import { EditForm } from "./edit-form";

// 读 db（better-sqlite3 原生模块）→ 全动态渲染
export const dynamic = "force-dynamic";

/**
 * 模型编辑页（M1 Task 8，server 侧）：取模型 / 默认配置 / 命名空间列表
 * 一次性下发给客户端表单。生效参数预览在客户端用 @/core/config 纯函数
 * 实时重算（本页不再起服务端请求），故无需预取 merged 结果。
 *
 * gguf 文件摘要（体积/分片数，UX P0 Task 5）供删除确认量化后果：
 * "删的是配置、留的是多大的文件"——磁盘占用是用户真正关心的数字。
 */
export default async function EditModelPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  const repo = createModelRepo(getDb());

  const model = repo.getModel(name);
  if (!model) notFound();

  const defaults = repo.getDefaultConfig();
  const namespaces = repo.listNamespaces();

  const resolved = resolveModelFiles(getPanelModelsRoot(), model.gguf_file);
  const ggufSummary = {
    sizeBytes: resolved.files.reduce((sum, f) => sum + f.size, 0),
    fileCount: resolved.files.length,
  };

  // 配置漂移（UX P0 Task 7）：本模型运行中且启动后保存过配置 → 表单顶部横幅
  const runtimeStatus = await decorateRuntimeStatus(getDb(), getRuntimeService());
  const runningEntry = runtimeStatus.running?.model === name ? runtimeStatus.running : null;
  const running = runningEntry !== null;
  const configStale = runningEntry?.configStale === true;

  return (
    <EditForm
      model={model}
      defaults={defaults}
      namespaces={namespaces}
      ggufSummary={ggufSummary}
      running={running}
      configStale={configStale}
    />
  );
}
