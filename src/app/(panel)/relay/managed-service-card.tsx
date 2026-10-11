"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Loader2, Pencil, Star } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { apiFetch } from "@/lib/api";
import { formatStartedAt } from "@/lib/relay-snippet";
import type { ManagedServiceView } from "@/server/relayOverview";
import { CopyField } from "./copy-field";

/**
 * 一个运行中托管模型的系统级信息卡片（只读）。操作只有「设为默认」与跳转编辑页，
 * 启停留在模型页——这里是「现在中转能打到谁、它是什么配置」的查看面。
 */
export function ManagedServiceCard({ service }: { service: ManagedServiceView }) {
  const t = useTranslations("pages.relay.managed");
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function setDefault() {
    setPending(true);
    setError(null);
    const res = await apiFetch("/api/v1/runtime/default-model", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: service.model }),
    }).catch(() => null);
    setPending(false);
    if (res?.ok) router.refresh();
    else setError(t("errorRequest"));
  }

  const unknown = t("unknown");
  const params = service.params;
  const rows: [string, string][] = [
    [t("container"), service.container],
    [t("hostPort"), service.hostPort !== null ? String(service.hostPort) : unknown],
    [t("upstream"), service.upstreamBase ?? unknown],
    [t("startedAt"), formatStartedAt(service.startedAt) ?? unknown],
  ];
  if (params !== null) {
    rows.push(
      [t("image"), params.image],
      [t("gpu"), params.gpu],
      [t("ctxSize"), String(params.ctxSize)],
      [t("gpuLayers"), String(params.gpuLayers)],
      [t("reasoningEffort"), params.reasoningEffort],
      [t("effortMapping"), t("effortMappingValue", { rounding: params.effortRounding, count: params.effortAliasCount })],
      [t("specType"), params.specType],
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <span>{service.displayName}</span>
          <Badge variant={service.ready ? "default" : "secondary"}>{service.ready ? t("ready") : t("loading")}</Badge>
          {service.isDefault && <Badge variant="outline">{t("default")}</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center gap-3 text-sm">
          <span className="text-muted-foreground">{t("modelName")}</span>
          <CopyField value={service.model} />
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="min-w-0 truncate font-mono text-[13px]" title={value}>
                {value}
              </dd>
            </div>
          ))}
        </dl>
        {params === null && <p className="text-xs text-muted-foreground">{t("paramsMissing")}</p>}
        {service.configStale && <p className="text-xs text-amber-600 dark:text-amber-500">{t("configStale")}</p>}
        <div className="flex items-center gap-1.5">
          {!service.isDefault && (
            <Button variant="outline" size="sm" disabled={pending} onClick={setDefault}>
              {pending ? <Loader2 className="animate-spin" /> : <Star className="size-3.5" />}
              {t("setDefault")}
            </Button>
          )}
          {params !== null && (
            <Link href={`/models/${service.model}/edit`} className={buttonVariants({ variant: "outline", size: "sm" })}>
              <Pencil className="size-3.5" />
              {t("edit")}
            </Link>
          )}
        </div>
        {error !== null && <p className="text-xs text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
