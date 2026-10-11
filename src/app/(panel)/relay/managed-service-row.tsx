"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { ChevronRight, Loader2, Pencil, Star } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import { formatStartedAt } from "@/lib/relay-snippet";
import { cn } from "@/lib/utils";
import type { ManagedServiceView } from "@/server/relayOverview";
import { CopyField } from "./copy-field";

interface Cell {
  label: string;
  value: string;
  /** 跨两列（长值：地址、镜像） */
  wide?: boolean;
  /** 值是说明文字而非标识符，不用等宽字体 */
  prose?: boolean;
}

/**
 * 一个运行中托管模型的清单行（只读）。点行头展开 / 收起参数区。操作只有「设为默认」与
 * 跳转编辑页，启停留在模型页——这里是「现在中转能打到谁、它是什么配置」的查看面。
 */
export function ManagedServiceRow({ service, defaultOpen }: { service: ManagedServiceView; defaultOpen: boolean }) {
  const t = useTranslations("pages.relay.managed");
  const router = useRouter();
  const [open, setOpen] = useState(defaultOpen);
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
  const cells: Cell[] = [
    { label: t("container"), value: service.container },
    { label: t("hostPort"), value: service.hostPort !== null ? String(service.hostPort) : unknown },
  ];
  if (params !== null) cells.push({ label: t("gpuLayers"), value: String(params.gpuLayers) });
  cells.push(
    { label: t("upstream"), value: service.upstreamBase ?? unknown, wide: true },
    { label: t("startedAt"), value: formatStartedAt(service.startedAt) ?? unknown },
  );
  if (params !== null) {
    cells.push(
      { label: t("image"), value: params.image, wide: true },
      { label: t("ctxSize"), value: String(params.ctxSize) },
      { label: t("gpu"), value: params.gpu },
      { label: t("reasoningEffort"), value: params.reasoningEffort },
      { label: t("specType"), value: params.specType },
      {
        label: t("effortMapping"),
        value: t("effortMappingValue", { rounding: params.effortRounding, count: params.effortAliasCount }),
        wide: true,
        prose: true,
      },
    );
  }

  return (
    <div>
      {/* 按主栏宽度（容器查询，见 relay-workspace.tsx）而不是视口断点排版：右栏占掉固定宽度后，
          主栏有多宽与视口宽度不成比例。放不下时端口收起、操作换到名字下面，名字不被挤成两行 */}
      {/* 整个行头可点：展开按钮本身不绑 onClick，键盘触发的 click 会冒泡到这里，只切换一次 */}
      <div
        className="grid cursor-pointer grid-cols-1 items-center gap-x-4 gap-y-2 px-4 py-3.5 hover:bg-muted/40 @[600px]:grid-cols-[minmax(0,1fr)_auto_auto]"
        onClick={() => setOpen((v) => !v)}
      >
        <div className="flex min-w-0 gap-2.5">
          <button
            type="button"
            aria-expanded={open}
            aria-label={t(open ? "collapse" : "expand", { name: service.displayName })}
            className="mt-px grid size-5 shrink-0 place-items-center rounded text-muted-foreground"
          >
            <ChevronRight className={cn("size-4 transition-transform", open && "rotate-90")} />
          </button>
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-base font-semibold">{service.displayName}</span>
              <Badge variant={service.ready ? "default" : "secondary"}>{service.ready ? t("ready") : t("loading")}</Badge>
              {service.isDefault && <Badge variant="outline">{t("default")}</Badge>}
            </div>
            {/* 小条里的名字要能点选、双击选词，不该顺带把行展开或收起 */}
            <div className="flex items-center gap-2 self-start" title={t("modelName")} onClick={(e) => e.stopPropagation()}>
              <CopyField variant="chip" value={service.model} />
            </div>
          </div>
        </div>
        {service.hostPort !== null && (
          <div className="hidden whitespace-nowrap @[600px]:block">
            <span className="mr-1.5 text-xs text-muted-foreground">{t("port")}</span>
            <span className="font-mono text-[13px]">{service.hostPort}</span>
          </div>
        )}
        <div
          className="flex flex-wrap items-center gap-1.5 pl-7.5 @[600px]:justify-end @[600px]:pl-0"
          onClick={(e) => e.stopPropagation()}
        >
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
      </div>

      {(error !== null || service.configStale) && (
        <div className="flex flex-col gap-1 px-4 pb-3 pl-11.5">
          {service.configStale && <p className="text-xs text-amber-700 dark:text-amber-500">{t("configStale")}</p>}
          {error !== null && <p className="text-xs text-destructive">{error}</p>}
        </div>
      )}

      {open && (
        <div className="px-4 pb-4 pl-11.5">
          <dl className="grid grid-flow-dense grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.3fr)] gap-x-5 rounded-lg border bg-muted/50 px-4 py-2.5">
            {cells.map((cell) => (
              <div key={cell.label} className={cn("min-w-0 py-1.5", cell.wide && "col-span-2")}>
                <dt className="text-xs whitespace-nowrap text-muted-foreground">{cell.label}</dt>
                <dd className={cn("truncate text-[13px]", !cell.prose && "font-mono")} title={cell.value}>
                  {cell.value}
                </dd>
              </div>
            ))}
          </dl>
          {params === null && <p className="mt-2 text-xs text-muted-foreground">{t("paramsMissing")}</p>}
        </div>
      )}
    </div>
  );
}
