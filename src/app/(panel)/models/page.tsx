import { Box } from "lucide-react";

import { PagePlaceholder } from "@/components/shell/page-placeholder";

export default function ModelsPage() {
  return (
    <PagePlaceholder
      title="模型"
      milestone="M1"
      description="模型配置列表与状态管理：状态、名称、量化、大小与操作，支持编辑生效参数与新建向导。"
      icon={Box}
    />
  );
}
