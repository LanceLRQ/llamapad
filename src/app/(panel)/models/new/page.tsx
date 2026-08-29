import { getDb } from "@/server/db";
import { getDiskUsage } from "@/server/fsScanner";
import { getNamespaceService, getPanelModelsRoot } from "@/server/locators";
import { createModelRepo } from "@/server/repo/models";
import { ModelWizard } from "./wizard";

// db + 磁盘扫描 → 全动态渲染
export const dynamic = "force-dynamic";

/**
 * 新建模型向导页（M2 Task 7，server 壳；M16 T8 二级栏化后标题/返回入口
 * 挪进 wizard.tsx 自己的 PageHeader/SecondaryNav，本页不再额外包一层标题）：
 * 一次装配向导初始数据（命名空间列表含 bytes、磁盘剩余、默认参数——占位与
 * 「跟随默认」文案用），四步交互全部在 client 组件 wizard.tsx 内完成
 * （浏览文件 / 新建空间 / 查重走 API，动作后按需刷新）。
 */
export default async function NewModelPage() {
  const namespaces = getNamespaceService().listOverview();
  const disk = await getDiskUsage(getPanelModelsRoot());
  const defaults = createModelRepo(getDb()).getDefaultConfig();

  return (
    <ModelWizard
      initialNamespaces={namespaces}
      initialDisk={{ totalBytes: disk.totalBytes, usedBytes: disk.usedBytes }}
      defaults={defaults}
    />
  );
}
