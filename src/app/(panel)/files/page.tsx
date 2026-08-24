import { Folder } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { PagePlaceholder } from "@/components/shell/page-placeholder";

export default async function FilesPage() {
  const t = await getTranslations("pages.files");
  return (
    <PagePlaceholder
      title={t("title")}
      milestone="M1"
      description={t("description")}
      icon={Folder}
    />
  );
}
