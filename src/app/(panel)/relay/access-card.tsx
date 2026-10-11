import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { CodeBlock } from "@/components/code-block";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { buildCurlSnippet, relayBaseUrls } from "@/lib/relay-snippet";
import type { EffectiveDefault } from "@/server/relayRouting";
import { CopyField } from "./copy-field";

/** 接入信息：中转地址、鉴权方式、默认模型、可复制的示例 */
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
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <dl className="grid grid-cols-[auto_1fr] items-center gap-x-6 gap-y-2.5 text-sm">
          <dt className="text-muted-foreground">{t("shortUrl")}</dt>
          <dd className="min-w-0">
            <CopyField value={urls.short} />
          </dd>
          <dt className="text-muted-foreground">{t("longUrl")}</dt>
          <dd className="min-w-0">
            <CopyField value={urls.long} />
          </dd>
          <dt className="text-muted-foreground">{t("auth")}</dt>
          <dd className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-mono text-[13px]">{t("authHint")}</span>
            <Link href="/settings?tab=account" className="text-primary hover:underline">
              {t("authLink")}
            </Link>
          </dd>
          <dt className="text-muted-foreground">{t("defaultModel")}</dt>
          <dd className="flex flex-wrap items-center gap-2">
            {defaultModel !== null ? (
              <>
                <CopyField value={defaultModel} />
                <Badge variant="outline">
                  {defaultTarget.kind === "external" ? t("kindExternal") : t("kindManaged")}
                </Badge>
              </>
            ) : (
              <span className="text-muted-foreground">{t("defaultNone")}</span>
            )}
          </dd>
        </dl>
        {defaultTarget.degraded && defaultUpstream !== null && defaultModel !== null && (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
            {t("degraded", { upstream: defaultUpstream, model: defaultModel })}
          </p>
        )}
        <p className="text-xs text-muted-foreground">{t("defaultHint")}</p>
        <div>
          <p className="mb-1.5 text-xs text-muted-foreground">{t("example")}</p>
          <CodeBlock>{buildCurlSnippet(urls.short, defaultModel)}</CodeBlock>
        </div>
      </CardContent>
    </Card>
  );
}
