import { MessageSquare } from "lucide-react";

import { PagePlaceholder } from "@/components/shell/page-placeholder";

export default function ChatPage() {
  return (
    <PagePlaceholder
      title="Chat"
      milestone="M3"
      description="内置对话调试：直连本地推理服务，用于验证模型参数与生成效果。"
      icon={MessageSquare}
    />
  );
}
