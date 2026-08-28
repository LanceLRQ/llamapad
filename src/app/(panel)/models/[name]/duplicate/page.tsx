import { notFound } from "next/navigation";

import { getDb } from "@/server/db";
import { getFilesTree } from "@/server/filesApi";
import { getPanelModelsRoot } from "@/server/locators";
import { createModelRepo } from "@/server/repo/models";
import { buildPickerItems } from "@/lib/model-file-picker";
import { DuplicateForm } from "./duplicate-form";

// 读 db（better-sqlite3 原生模块）+ 扫盘 → 全动态渲染
export const dynamic = "force-dynamic";

/**
 * 模型克隆页（规格 §5）：把原模型的全部配置预填进一张新建表单，提交时才落库。
 *
 * 刻意不做的事：不查运行状态、不解析 GGUF 头、不算配置漂移——那三样描述的
 * 都是「这条已存在的记录此刻怎么样」，对一条还没创建的配置没有意义。
 */
export default async function DuplicateModelPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  const repo = createModelRepo(getDb());

  const source = repo.getModel(name);
  if (!source) notFound();

  const defaults = repo.getDefaultConfig();
  const namespaces = repo.listNamespaces();
  const pickerItems = buildPickerItems(
    getFilesTree(getDb(), getPanelModelsRoot()).flatMap((ns) => ns.files),
  );

  return (
    <DuplicateForm
      source={source}
      defaults={defaults}
      namespaces={namespaces}
      pickerItems={pickerItems}
    />
  );
}
