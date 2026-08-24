import { Folder } from "lucide-react";

import { PagePlaceholder } from "@/components/shell/page-placeholder";

export default function FilesPage() {
  return (
    <PagePlaceholder
      title="文件"
      milestone="M1"
      description="GGUF 文件浏览：磁盘占用总览、目录树 + 文件表，选中后提供移动 / 删除等管理操作。"
      icon={Folder}
    />
  );
}
