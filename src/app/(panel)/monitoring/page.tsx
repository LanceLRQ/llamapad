import { Activity } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { PagePlaceholder } from "@/components/shell/page-placeholder";

export default async function MonitoringPage() {
  const t = await getTranslations("pages.monitoring");
  return (
    <PagePlaceholder
      title={t("title")}
      milestone="M3"
      description={t("description")}
      icon={Activity}
    />
  );
}
