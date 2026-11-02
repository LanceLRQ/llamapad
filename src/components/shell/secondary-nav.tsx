"use client";

import { Fragment, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Check, ChevronDown, type LucideIcon } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { SettingTip } from "@/components/setting-tip";
import { cn } from "@/lib/utils";

interface SecondaryNavItem {
  key: string;
  name: string;
  meta?: string;
  lead: { kind: "number"; text: string } | { kind: "count"; value: number } | { kind: "icon"; icon: LucideIcon };
  state?: "done" | "locked";
  marker?: { tone: "running" | "alert"; title: string };
  title?: string;
  tone?: "danger";
  href?: string;
  selected?: boolean;
}

interface SecondaryNavProps {
  preserveDraft?: boolean;
  variant?: "tabs" | "menu" | "steps";
  title: string;
  items: SecondaryNavItem[];
  queryKey: string;
  current: string;
  groups?: { beforeKey: string; label?: string; tip?: string; action?: ReactNode }[];
  header?: ReactNode;
  titleAction?: ReactNode;
  action?: ReactNode;
  footer?: ReactNode;
}

/** 页面内的视图、步骤与目录选择；模块入口由主侧栏承载。 */
export function SecondaryNav({ preserveDraft = false, variant = "tabs", title, items, queryKey, current, groups, header, titleAction, action, footer }: SecondaryNavProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function itemHref(item: SecondaryNavItem): string {
    if (item.href) return item.href;
    const params = new URLSearchParams(searchParams.toString());
    params.set(queryKey, item.key);
    return pathname + "?" + params.toString();
  }

  const selected = items.find((item) => item.selected ?? item.key === current);
  return (
    <nav aria-label={title} className="secondary-nav flex w-full shrink-0 flex-wrap items-center gap-2 border-b bg-background px-4 py-2 sm:px-7">
      {header && <div className="secondary-nav-back shrink-0">{header}</div>}
      {variant === "menu" ? (
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" className="min-w-0 max-w-full justify-between gap-4 sm:min-w-56" aria-label={title} />}>
            <span className="truncate">{selected?.name ?? title}</span><ChevronDown className="size-4 shrink-0" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-[min(70vh,560px)] max-w-[calc(100vw-32px)] overflow-y-auto">
            {items.map((item) => {
              const group = groups?.find((entry) => entry.beforeKey === item.key);
              return (
                <Fragment key={item.key}>
                  {group && <><DropdownMenuSeparator />{group.label && <div className="px-2 py-1 text-xs text-muted-foreground">{group.label}</div>}</>}
                  <DropdownMenuItem disabled={item.state === "locked"} render={<Link href={itemHref(item)} data-preserves-draft={preserveDraft || undefined} replace={!item.href} scroll={false} aria-current={(item.selected ?? item.key === current) ? "page" : undefined} />} className="min-h-10">
                    {item.lead.kind === "icon" && <item.lead.icon className="size-4 text-muted-foreground" />}
                    <span className="min-w-0 flex-1 break-words">{item.name}</span>
                    {item.lead.kind === "count" && <span className="font-mono text-xs tabular-nums text-muted-foreground">{item.lead.value}</span>}
                    {(item.selected ?? item.key === current) && <Check className="size-3.5" />}
                  </DropdownMenuItem>
                </Fragment>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : items.map((item) => {
        const active = item.selected ?? item.key === current;
        const className = cn(buttonVariants({ variant: "ghost", size: "sm" }), "min-h-9 text-muted-foreground", active && "bg-accent font-semibold text-foreground", item.tone === "danger" && "text-destructive");
        const content = <>
          {variant === "steps" && (item.state === "done" ? <Check className="size-3.5 text-accent-green" /> : item.lead.kind === "number" ? <span className="font-mono text-xs">{item.lead.text}</span> : null)}
          {item.name}
          {item.marker && <span title={item.marker.title} className={cn("size-1.5 rounded-full", item.marker.tone === "alert" ? "bg-destructive" : "bg-accent-green")} />}
        </>;
        return item.state === "locked"
          ? <Button key={item.key} type="button" variant="ghost" size="sm" disabled title={item.title} className="min-h-9">{content}</Button>
          : <Link key={item.key} href={itemHref(item)} data-preserves-draft={preserveDraft || undefined} replace={!item.href} scroll={false} aria-current={active ? "page" : undefined} title={item.title ?? item.meta} className={className}>{content}</Link>;
      })}
      {titleAction}
      {groups?.filter((group) => group.action).map((group) => <span key={group.beforeKey} className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">{group.label}{group.tip && <SettingTip text={group.tip} />}{group.action}</span>)}
      {action && <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-2.5">{action}</div>}
      {footer}
    </nav>
  );
}
