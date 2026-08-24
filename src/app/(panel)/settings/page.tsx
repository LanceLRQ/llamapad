import { Settings } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { PagePlaceholder } from "@/components/shell/page-placeholder";

export default async function SettingsPage() {
  const t = await getTranslations("pages.settings");
  return (
    <PagePlaceholder
      title={t("title")}
      milestone="M1"
      description={t("description")}
      icon={Settings}
    />
  );
}
