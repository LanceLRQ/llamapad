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
  // 二级栏标题旁「＋新建」入口用：与 models/page.tsx 的 allFolders 同款口径，
  // 复用已经扫过的 tree，不再多扫一次盘
  const folders = tree.map((g) => g.folder);

  return (
    // 二级栏必须贴到应用外壳的框边：与 models/page.tsx、downloads/page.tsx
    // 同款负边距过渡做法，见那两处的同款注释
    //
    // h- 而非 min-h-：min-h-full 只等于 main 的内容盒（不含抵消掉的
    // pt-7 28 + pb-12 48 = 76px），二级栏右边框会停在离底 76px 处；定高后
    // 内容不再撑长 main，右侧内容列改由自己滚动（见 ReposView 内的 overflow-y-auto）
    <div className="-mx-[34px] -mt-7 -mb-12 flex h-[calc(100%+76px)]">
      <ReposView profiles={profiles} folders={folders} />
    </div>
  );
}
