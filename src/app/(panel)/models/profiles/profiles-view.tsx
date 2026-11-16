"use client";

import { useContext, useState } from "react";
import Link from "next/link";
import { Box, Plus } from "lucide-react";
import { useTranslations } from "next-intl";

import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { toGigabytes } from "@/lib/format";
import type { ModelView } from "@/server/modelsView";
import { ModelsTable } from "../models-table";
import { NamespaceFilter } from "../namespace-filter";
import { RepoCreateNavButton } from "../repo-create-nav-button";
import { ProfileEditorContext } from "./workspace";

export function ProfilesView({ models, namespace, namespaces, folders }: {
  models: ModelView[];
  namespace: string;
  namespaces: string[];
  folders: string[];
}) {
  const t = useTranslations("pages.models");
  const { editing, change } = useContext(ProfileEditorContext)!;
  const [data, setData] = useState(() => ({ source: models, rows: models, change }));

  // A new server snapshot (for example after starting a model) replaces local edits.
  // Closing the editor only applies its changed row to the current snapshot.
  if (data.source !== models) {
    setData({ source: models, rows: models, change });
  } else if (data.change !== change && change) {
    const rows = data.rows.flatMap((row) => row.name !== change.name ? [row] : change.model ? [change.model] : []);
    setData({ source: models, rows, change });
  }

  const rows = data.rows;
  const slice = namespace === "all" ? rows : rows.filter((row) => row.namespace === namespace);
  const options = ["all", ...namespaces].map((value) => {
    const group = value === "all" ? rows : rows.filter((row) => row.namespace === value);
    return {
      value,
      label: value === "all" ? t("nsAll") : value,
      count: group.length,
      sizeBytes: group.reduce((sum, row) => sum + row.sizeBytes, 0),
      running: group.some((row) => row.status === "running"),
    };
  });

  return (
    <>
      <div hidden={editing !== null}>
        <PageHeader
          icon={Box}
          title={t("tabs.configs.meta")}
          action={
            <div className="flex flex-wrap items-center gap-2">
              <RepoCreateNavButton folders={folders} variant="outline" />
              <Button size="sm" nativeButton={false} render={<Link href="/models/new" />}>
                <Plus />
                {t("newModel")}
              </Button>
            </div>
          }
        />
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b px-4 py-2 sm:px-7">
          <NamespaceFilter value={namespace} options={options} />
          <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {[
              [t("statModels"), slice.length],
              [t("statSize"), `${toGigabytes(slice.reduce((sum, row) => sum + row.sizeBytes, 0))} GB`],
              [t("statRunning"), slice.filter((row) => row.status === "running").length],
            ].map(([label, value]) => (
              <div key={label} className="flex items-baseline gap-1.5">
                <dt>{label}</dt>
                <dd className="font-mono font-semibold tabular-nums text-foreground">{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>

      {rows.length > 0 || editing !== null ? (
        <ModelsTable models={slice} namespaces={namespaces} folders={folders} groupByNamespace={namespace === "all"} editing={editing} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-7">
          <Card>
            <CardContent className="flex flex-col items-center gap-2 py-16 text-center">
              <Box className="size-6 text-muted-foreground" />
              <p className="text-sm font-medium">{t("emptyTitle")}</p>
              <p className="max-w-md text-sm text-muted-foreground">{t("emptyDescription")}</p>
            </CardContent>
          </Card>
        </div>
      )}
    </>
  );
}
