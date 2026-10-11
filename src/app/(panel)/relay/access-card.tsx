import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { buildCurlSnippet, relayBaseUrls } from "@/lib/relay-snippet";
import type { EffectiveDefault } from "@/server/relayRouting";
import { CopyField } from "./copy-field";
import { CurlExample } from "./curl-example";

/** 接入信息（右侧栏紧凑版）：中转地址、鉴权方式、默认模型、可复制的示例 */
export async function AccessCard({
  origin,
  defaultTarget,
  defaultUpstream,
}: {
  origin: string;
  defaultTarget: EffectiveDefault;
  /** 用户设置的默认上游名；降级提示里要说出是谁不可达 */
  defaultUpstream: string | null;
}) {
  const t = await getTranslations("pages.relay.access");
  const urls = relayBaseUrls(origin);
  const defaultModel = defaultTarget.name;

  return (
    <Card className="shrink-0 gap-0 px-3 py-3">
      <h2 className="text-sm font-semibold">{t("title")}</h2>
      <p className="mb-1.5 text-xs text-muted-foreground">{t("description")}</p>

      <div className="mt-1.5">
        <div className="mb-0.5 min-h-4.5 text-xs text-muted-foreground">{t("shortUrl")}</div>
        <CopyField variant="chip" small value={urls.short} />
      </div>
      <div className="mt-1.5">
        <div className="mb-0.5 min-h-4.5 text-xs text-muted-foreground">{t("longUrl")}</div>
        <CopyField variant="chip" small value={urls.long} />
      </div>
      <div className="mt-1.5">
        <div className="mb-0.5 flex min-h-4.5 items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>{t("auth")}</span>
          <Link href="/settings?tab=account" className="text-amber-700 hover:underline dark:text-amber-400">
            {t("authLink")}
          </Link>
        </div>
        <code className="font-mono text-xs">{t("authHint")}</code>
      </div>
      <div className="mt-1.5">
        <div className="mb-0.5 flex min-h-4.5 items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>{t("defaultModel")}</span>
          {defaultModel !== null && (
            <Badge variant="outline" className="h-4.5 px-1.5">
              {defaultTarget.kind === "external" ? t("kindExternal") : t("kindManaged")}
            </Badge>
          )}
        </div>
        {defaultModel !== null ? (
          <CopyField variant="chip" small value={defaultModel} />
        ) : (
          <span className="text-xs text-muted-foreground">{t("defaultNone")}</span>
        )}
      </div>

      {defaultTarget.degraded && defaultUpstream !== null && defaultModel !== null && (
        <p className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-xs">
          {t("degraded", { upstream: defaultUpstream, model: defaultModel })}
        </p>
      )}
      <p className="mt-2 text-xs leading-snug text-muted-foreground">{t("defaultHint")}</p>

      <CurlExample curl={buildCurlSnippet(urls.short, defaultModel)} />
    </Card>
  );
}
