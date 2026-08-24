import { Download } from "lucide-react";

import { PagePlaceholder } from "@/components/shell/page-placeholder";

export default function DownloadsPage() {
  return (
    <PagePlaceholder
      title="下载"
      milestone="M2"
      description="模型下载管理：任务进度 / 速度 / 分片明细，断点续传与 sha256 校验，镜像来源与历史记录。"
      icon={Download}
    />
  );
}
