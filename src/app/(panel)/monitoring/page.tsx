import { Activity } from "lucide-react";

import { PagePlaceholder } from "@/components/shell/page-placeholder";

export default function MonitoringPage() {
  return (
    <PagePlaceholder
      title="监控"
      milestone="M3"
      description="实时监控：GPU / 容器 / 推理指标卡与 sparkline，全宽终端日志流。"
      icon={Activity}
    />
  );
}
