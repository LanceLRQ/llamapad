import { Settings } from "lucide-react";

import { PagePlaceholder } from "@/components/shell/page-placeholder";

export default function SettingsPage() {
  return (
    <PagePlaceholder
      title="设置"
      milestone="M1"
      description="面板设置：管理员密码、API Token 管理与面板运行偏好。"
      icon={Settings}
    />
  );
}
