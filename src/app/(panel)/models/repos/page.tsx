import { getDb } from "@/server/db";
import { scanTree } from "@/server/fsScanner";
import { getPanelModelsRoot } from "@/server/locators";
import { decorateProfileStats, listProfiles } from "@/server/repoProfiles";
import { ReposView } from "./repos-view";

// db + 文件扫描（fs）→ 全动态渲染
export const dynamic = "force-dynamic";

/**
 * 仓库档案列表页（任务 9）：数据只有 DB + 扫盘，毫秒级——与 downloads/page.tsx
 * 同款分工，server 侧一次装配（`decorateProfileStats` 与 GET /api/v1/repos
 * 共用同一份口径，任务 9 复核 D2 抽出，不再两处各抄一份），交给客户端组件
 * <ReposView> 渲染二级栏 + 页头 + 卡片网格。与详情页不同，本页没有需要等待
 * 的外网请求，不必分两段加载（任务 9 补充裁定 1）。
 */
export default async function ReposPage() {
  const root = getPanelModelsRoot();
  const tree = scanTree(root);
  const profiles = decorateProfileStats(listProfiles(getDb()), tree);

  return (
    // 二级栏必须贴到应用外壳的框边：与 models/page.tsx、downloads/page.tsx
    // 同款负边距过渡做法，见那两处的同款注释
    <div className="-mx-[34px] -mt-7 -mb-12 flex min-h-full">
      <ReposView profiles={profiles} />
    </div>
  );
}
