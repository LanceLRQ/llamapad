import { LayoutDashboard } from "lucide-react";

import { PagePlaceholder } from "@/components/shell/page-placeholder";

export default function OverviewPage() {
  return (
    <PagePlaceholder
      title="概览"
      milestone="M3"
      description="运行状态总览：GPU 显存与利用率趋势、容器 / 推理指标、磁盘占用与事件日志流。"
      icon={LayoutDashboard}
    />
  );
}
