import { StatusBarClient } from "@/components/shell/status-bar-client";
import { getDb } from "@/server/db";
import { getRuntimeService } from "@/server/locators";
import { decorateRuntimeStatus } from "@/server/modelsView";

/**
 * 应用外壳状态栏（server 壳，M16 T1；行为承接自旧顶栏组件的运行状态 chip）。
 *
 * 只负责取运行状态这一件 server 端的事，其余（下载进展 / GPU/磁盘轮询 /
 * 离线态 / 主题语言切换）都是纯 client 交互，拆到 status-bar-client.tsx。
 *
 * chip 数据：getRuntimeStatus 从容器 label 推导（无内存状态），displayName /
 * hostPort 经 decorateRuntimeStatus 从 repo 模型行补齐；container 原样带下去
 * 给 client 拼 title（"当前运行模型 · 容器 xxx"）——旧顶栏就是拿容器名做
 * chip 的悬浮提示，换成状态栏不能把这条信息弄丢。docker 查询失败（socket
 * 异常等）时按"未运行"展示，不让状态栏炸掉整页——每个面板页都会渲染状态栏，
 * 这里没有缓存，与旧顶栏同一取舍（缓存留待后续里程碑）。
 *
 * 运行状态的刷新时机与旧顶栏一致：页面导航时随 server 组件重渲染，不做
 * client 侧轮询——容器切换本就发生在同一个面板会话的操作之后，操作方自己
 * 会触发导航/刷新，不需要额外轮询。
 */
export async function StatusBar() {
  let running: { displayName: string; container: string; hostPort: number | null } | null = null;
  try {
    const status = await decorateRuntimeStatus(getDb(), getRuntimeService());
    if (status.running) {
      running = {
        displayName: status.running.displayName,
        container: status.running.container,
        hostPort: status.running.hostPort,
      };
    }
  } catch {
    running = null;
  }

  return <StatusBarClient running={running} />;
}
