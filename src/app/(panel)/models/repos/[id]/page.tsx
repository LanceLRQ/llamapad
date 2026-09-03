import { notFound } from "next/navigation";

import { parseLandingSetting, REPO_README_LANDING_KEY } from "@/lib/repo-readme-tabs";
import { getDb } from "@/server/db";
import { createModelRepo } from "@/server/repo/models";
import { getProfile } from "@/server/repoProfiles";
import { getConfiguredScanDirs } from "@/server/scanDirs";
import { RepoDetailView } from "./repo-detail-view";

// 读 db（better-sqlite3 原生模块）→ 全动态渲染
export const dynamic = "force-dynamic";

/**
 * 档案详情页（任务 9）：本页只取档案本身（`getProfile`，DB 单行查询，毫秒级），
 * 拿不到就 404——量化清单要打 HF，国内网络下可能超时十几秒，绝不能放进这里
 * await，否则整页 SSR 卡死变白屏（任务 9 补充裁定 1）。真正的文件状态由
 * <RepoDetailView> 客户端挂载后自己 fetch `/api/v1/repos/:id/files`，期间
 * 显示加载态，失败给可重试的错误块——这条路正是任务 7 建那个合并端点的
 * 原因。
 */
export default async function RepoDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: rawId } = await params;
  const id = Number(rawId);
  if (!Number.isInteger(id)) notFound();

  const profile = getProfile(getDb(), id);
  if (profile === null) notFound();

  // 落地视图在 SSR 就定下来：放到客户端读会先闪一下 README 再跳走
  const landingRow = getDb()
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(REPO_README_LANDING_KEY) as { value: string } | undefined;
  const landingReadme = parseLandingSetting(landingRow?.value);

  // README 推荐卡的 diff 基准：全局默认 server 配置（档案页没有具体模型上下文，
  // 只能用这个近似「当前生效值」）
  const effective = createModelRepo(getDb()).getDefaultConfig().server;

  // 深度扫描的自定义目录（宿主机视角，全局设置）：在 SSR 就取好回填输入框——
  // 这是当前真正生效的扫描范围，只存在服务端而界面上看不见的话，用户既不知道
  // 现在扫的是哪些目录，也没法把它改回去
  const scanExtraDirs = getConfiguredScanDirs(getDb());

  return (
    // h- 而非 min-h-：min-h-full 只等于 main 的内容盒（不含抵消掉的
    // pt-7 28 + pb-12 48 = 76px），二级栏右边框会停在离底 76px 处；定高后
    // 内容不再撑长 main，右侧内容列改由自己滚动（见 RepoDetailView 内的 overflow-y-auto）
    <div className="-mx-[34px] -mt-7 -mb-12 flex h-[calc(100%+76px)]">
      <RepoDetailView
        profile={profile}
        landingReadme={landingReadme}
        effective={effective}
        scanExtraDirs={scanExtraDirs}
      />
    </div>
  );
}
