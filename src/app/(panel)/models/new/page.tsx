import { redirect } from "next/navigation";

import { getDb } from "@/server/db";
import { getFilesTree } from "@/server/filesApi";
import { getPanelModelsRoot } from "@/server/locators";
import { createModelRepo } from "@/server/repo/models";
import { buildPickerItems } from "@/lib/model-file-picker";
import { ModelWizard } from "./wizard";

// db + 扫盘（文件选择弹层候选项） → 全动态渲染
export const dynamic = "force-dynamic";

/**
 * 新建模型向导页（M2 Task 7，server 壳；M16 T8 二级栏化后标题/返回入口
 * 挪进 wizard.tsx 自己的 PageHeader/SecondaryNav；「仓库档案与下载解耦」
 * 批 5 起下载归仓库档案页管，本页只装配「选文件 + 填参数」两步需要的
 * 只读数据：命名空间列表、默认参数、文件选择弹层候选项（与编辑页/克隆页
 * 同款做法，server 侧直接扫盘装配，不经客户端请求）。
 *
 * `?file=<rel>` 深链（仓库档案页「建配置」按钮的落点）在这里、而不是
 * client 组件里接：不带 `step=` 时服务端直接 redirect 补上 `step=2`——
 * 这样浏览器拿到的第一份 HTML 就已经是步骤 2，不会先闪一下步骤 1 再跳转。
 * 已经带 `step=` 说明用户在这条深链上又做了自己的导航（比如手动退回步骤
 * 1 重选文件），尊重这份状态，不再覆盖。
 */
export default async function NewModelPage({
  searchParams,
}: {
  searchParams: Promise<{ file?: string; step?: string }>;
}) {
  const { file, step } = await searchParams;
  if (file !== undefined && step === undefined) {
    redirect(`/models/new?file=${encodeURIComponent(file)}&step=2`);
  }

  const repo = createModelRepo(getDb());
  const namespaces = repo.listNamespaces();
  const defaults = repo.getDefaultConfig();
  const pickerItems = buildPickerItems(
    getFilesTree(getDb(), getPanelModelsRoot()).flatMap((ns) => ns.files),
  );

  return (
    <ModelWizard
      namespaces={namespaces}
      defaults={defaults}
      pickerItems={pickerItems}
      initialFile={file ?? null}
    />
  );
}
