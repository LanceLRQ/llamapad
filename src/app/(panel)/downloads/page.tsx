import { Download } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { PagePlaceholder } from "@/components/shell/page-placeholder";

export default async function DownloadsPage() {
  const t = await getTranslations("pages.downloads");
  return (
    <PagePlaceholder
      title={t("title")}
      milestone="M2"
      description={t("description")}
      icon={Download}
    />
  );
}
