import { LayoutDashboard } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { PagePlaceholder } from "@/components/shell/page-placeholder";

export default async function OverviewPage() {
  const t = await getTranslations("pages.overview");
  return (
    <PagePlaceholder
      title={t("title")}
      milestone="M3"
      description={t("description")}
      icon={LayoutDashboard}
    />
  );
}
