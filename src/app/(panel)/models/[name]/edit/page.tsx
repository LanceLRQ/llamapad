import { notFound } from "next/navigation";

import { getDb } from "@/server/db";
import { createModelRepo } from "@/server/repo/models";
import { EditForm } from "./edit-form";

// 读 db（better-sqlite3 原生模块）→ 全动态渲染
export const dynamic = "force-dynamic";

/**
 * 模型编辑页（M1 Task 8，server 侧）：取模型 / 默认配置 / 命名空间列表
 * 一次性下发给客户端表单。生效参数预览在客户端用 @/core/config 纯函数
 * 实时重算（本页不再起服务端请求），故无需预取 merged 结果。
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

  return <EditForm model={model} defaults={defaults} namespaces={namespaces} />;
}
