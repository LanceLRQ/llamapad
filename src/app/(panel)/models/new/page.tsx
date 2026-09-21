import { redirect } from "next/navigation";

import { getDb } from "@/server/db";
import { getPanelModelsRoot } from "@/server/locators";
import { listConfiguredPorts } from "@/server/modelsView";
import { buildPickerFiles } from "@/server/pickerFiles";
import { createModelRepo } from "@/server/repo/models";
import { buildPickerItems } from "@/lib/model-file-picker";
import { parseServerParam } from "@/lib/new-model-link";
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
 *
 * `?server=<json>`（README 推荐卡「应用到建配置」时随 `?file=` 一起带来）：
 * 补 `step=2` 的 redirect 要原样把它带回去，否则这一跳会把推荐参数丢在
 * 半路；`parseServerParam` 解析成 `initialServer` 交给 `ModelWizard` 当
 * `overrides.server` 的初值，非法/空值一律解成 `undefined`，向导按"没有
 * 推荐参数"的既有路径处理。
 */
export default async function NewModelPage({
  searchParams,
}: {
  searchParams: Promise<{ file?: string; step?: string; server?: string }>;
}) {
  const { file, step, server } = await searchParams;
  if (file !== undefined && step === undefined) {
    const serverQuery = server !== undefined ? `&server=${encodeURIComponent(server)}` : "";
    redirect(`/models/new?file=${encodeURIComponent(file)}&step=2${serverQuery}`);
  }

  const repo = createModelRepo(getDb());
  const namespaces = repo.listNamespaces();
  const defaults = repo.getDefaultConfig();
  const pickerItems = buildPickerItems(await buildPickerFiles(getDb(), getPanelModelsRoot()));

  return (
    <ModelWizard
      namespaces={namespaces}
      defaults={defaults}
      pickerItems={pickerItems}
      initialFile={file ?? null}
      initialServer={parseServerParam(server)}
      peerPorts={listConfiguredPorts(getDb())}
    />
  );
}
