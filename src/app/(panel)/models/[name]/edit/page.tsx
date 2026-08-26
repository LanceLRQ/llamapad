import path from "node:path";
import { notFound } from "next/navigation";

import { resolveModelFiles } from "@/server/fsScanner";
import { getDb } from "@/server/db";
import { getGgufMeta } from "@/server/ggufMeta";
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

  // GGUF 元数据（UX P1 U16 后半）：分片组取排序后第一个文件——llama.cpp 的分片约定里
  // 第一片持有完整 KV 元数据；文件缺失/损坏时 getGgufMeta 返回 null，页面据此整段不渲染
  const firstFile = resolved.files[0];
  const ggufMeta = firstFile
    ? await getGgufMeta(getDb(), path.join(getPanelModelsRoot(), firstFile.rel))
    : null;

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
      ggufMeta={ggufMeta}
      running={running}
      configStale={configStale}
    />
  );
}
