import { Box } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { PagePlaceholder } from "@/components/shell/page-placeholder";

export default async function ModelsPage() {
  const t = await getTranslations("pages.models");
  return (
    <PagePlaceholder
      title={t("title")}
      milestone="M1"
      description={t("description")}
      icon={Box}
    />
  );
}
