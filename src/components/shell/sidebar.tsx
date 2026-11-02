"use client";

import { useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { BookOpen, Box, ChevronDown, Download, Folder, LayoutDashboard, LogOut, Menu, MessageSquare, PanelLeftClose, PanelLeftOpen, ScrollText, Settings, Waypoints } from "lucide-react";
import { useTranslations } from "next-intl";

import { apiFetch } from "@/lib/api";
import { sidebarCollapseStore } from "@/lib/sidebar-collapse";
import { sidebarChildren, type SidebarSection } from "@/lib/sidebar-nav";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

interface NavItem {
  href: string;
  labelKey: "overview" | "models" | "downloads" | "files" | "logs" | "chat" | "relay" | "docs" | "settings";
  icon: typeof LayoutDashboard;
  section?: SidebarSection;
}

const NAV_MAIN: NavItem[] = [
  { href: "/", labelKey: "overview", icon: LayoutDashboard },
  { href: "/models", labelKey: "models", icon: Box, section: "models" },
  { href: "/downloads", labelKey: "downloads", icon: Download, section: "downloads" },
  { href: "/files", labelKey: "files", icon: Folder },
  { href: "/logs", labelKey: "logs", icon: ScrollText, section: "logs" },
  { href: "/chat", labelKey: "chat", icon: MessageSquare },
  { href: "/relay", labelKey: "relay", icon: Waypoints },
  { href: "/docs", labelKey: "docs", icon: BookOpen },
];
const SETTINGS_ITEM: NavItem = { href: "/settings", labelKey: "settings", icon: Settings, section: "settings" };

function isActive(pathname: string, href: string): boolean {
  return pathname === href || (href !== "/" && pathname.startsWith(href + "/"));
}

/** 桌面与抽屉共用两级导航；切换模块时由 key 重置为展开当前模块。 */
function NavigationTree({ pathname, search, activeSection, collapsed = false, mobile = false, onNavigate }: {
  pathname: string;
  search: string;
  activeSection?: SidebarSection;
  collapsed?: boolean;
  mobile?: boolean;
  onNavigate?: () => void;
}) {
  const t = useTranslations("nav");
  const tr = useTranslations();
  const [expanded, setExpanded] = useState<SidebarSection | undefined>(activeSection);

  function renderItem(item: NavItem) {
    const active = isActive(pathname, item.href);
    const children = item.section ? sidebarChildren(item.section, pathname, search) : [];
    const label = t(item.labelKey);
    const rowClass = cn("flex min-w-0 flex-1 items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring", mobile && "min-h-11", !mobile && "collapsed:justify-center collapsed:px-0", collapsed && "justify-center px-0", active && "font-semibold text-foreground", active && !children.length && "bg-accent");
    const icon = <item.icon className="size-4 shrink-0" />;

    if (collapsed && children.length) {
      return (
        <DropdownMenu key={item.href}>
          <DropdownMenuTrigger render={<Button variant="ghost" className={cn(rowClass, "w-full flex-none")} aria-label={label} title={label} />}>{icon}</DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="start">
            {children.map((child) => <DropdownMenuItem key={child.key} render={<Link href={child.href} aria-current={child.active ? "page" : undefined} />} className={cn("min-h-9", child.active && "bg-accent font-medium")}>{tr(child.labelKey)}</DropdownMenuItem>)}
          </DropdownMenuContent>
        </DropdownMenu>
      );
    }

    return (
      <div key={item.href}>
        {item.section ? (
          <Button variant="ghost" className={cn(rowClass, "h-9 w-full flex-none justify-start py-0 aria-expanded:bg-transparent aria-expanded:hover:bg-accent")} aria-expanded={expanded === item.section} aria-label={t(expanded === item.section ? "collapseGroup" : "expandGroup", { group: label })} onClick={() => setExpanded(expanded === item.section ? undefined : item.section)}>
            {icon}<span className={mobile ? undefined : "collapsed:hidden"}>{label}</span>
            <ChevronDown className={cn("ml-auto size-3.5 shrink-0 transition-transform", !mobile && "collapsed:hidden", expanded === item.section && "rotate-180")} />
          </Button>
        ) : (
          <Link href={item.href} aria-current={active ? "page" : undefined} title={collapsed ? label : undefined} className={rowClass} onClick={onNavigate}>
            {icon}{!collapsed && <span className={mobile ? undefined : "collapsed:hidden"}>{label}</span>}
          </Link>
        )}
        {!collapsed && item.section && expanded === item.section && (
          <div className={cn("mb-2 mt-0.5 flex flex-col gap-0.5", !mobile && "collapsed:hidden")} aria-label={label}>
            {children.map((child) => <Link key={child.key} href={child.href} aria-current={child.active ? "page" : undefined} onClick={onNavigate} className={cn("flex min-h-9 items-center rounded-md py-1.5 pl-10 pr-2 text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring", mobile && "min-h-11 text-sm", child.active && "bg-accent font-medium text-foreground")}>{tr(child.labelKey)}</Link>)}
          </div>
        )}
      </div>
    );
  }

  return (
    <nav aria-label="llamapad" className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">{NAV_MAIN.map(renderItem)}</div>
      <div className="shrink-0 border-t pt-3">{renderItem(SETTINGS_ITEM)}</div>
    </nav>
  );
}

export function Sidebar() {
  const t = useTranslations("nav");
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const router = useRouter();
  const [loggingOut, setLoggingOut] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const collapsed = useSyncExternalStore(sidebarCollapseStore.subscribe, sidebarCollapseStore.getSnapshot, sidebarCollapseStore.getServerSnapshot);
  const activeSection = [...NAV_MAIN, SETTINGS_ITEM].find((item) => isActive(pathname, item.href))?.section;
  const treeProps = { pathname, search, activeSection };

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await apiFetch("/api/v1/auth/logout", { method: "POST" });
    } finally {
      router.push("/login");
      router.refresh();
    }
  }

  return (
    <>
      <div className="flex h-12 items-center gap-3 border-b bg-sidebar px-4 lg:hidden">
        <Dialog open={menuOpen} onOpenChange={setMenuOpen}>
          <DialogTrigger render={<Button variant="ghost" size="icon" aria-label={t("expandSidebar")} />}><Menu className="size-5" /></DialogTrigger>
          <DialogContent className="top-0 left-0 flex h-dvh max-w-[min(320px,90vw)] translate-x-0 translate-y-0 flex-col overflow-hidden rounded-none p-5 sm:max-w-[320px]">
            <DialogTitle>llamapad</DialogTitle>
            <NavigationTree key={activeSection ?? pathname} {...treeProps} mobile onNavigate={() => setMenuOpen(false)} />
            <Button variant="ghost" disabled={loggingOut} onClick={handleLogout} className="justify-start"><LogOut className="size-4" />{t("logout")}</Button>
          </DialogContent>
        </Dialog>
        <span className="text-sm font-semibold">llamapad</span>
      </div>

      <aside className="hidden min-h-0 w-[240px] shrink-0 flex-col border-r bg-sidebar px-3 py-4 transition-[width] duration-200 lg:flex collapsed:w-[60px] collapsed:px-2 motion-reduce:transition-none">
        <div className="group/brand relative flex items-center justify-between gap-2 px-2.5 pb-5 pt-1 collapsed:justify-center collapsed:px-0">
          <div className="flex items-center gap-2.5 text-[15px] font-bold transition-opacity collapsed:pointer-events-none collapsed:absolute collapsed:top-1 collapsed:left-1/2 collapsed:-translate-x-1/2 collapsed:group-hover/brand:opacity-0 collapsed:group-has-[:focus-visible]/brand:opacity-0">
            {/* eslint-disable-next-line @next/next/no-img-element -- 静态品牌图，无需图片优化。 */}
            <img src="/logo.webp" alt="" width={28} height={28} className="size-7 shrink-0 rounded-lg" />
            <span className="collapsed:hidden">llamapad</span>
          </div>
          <button type="button" onClick={sidebarCollapseStore.toggle} aria-expanded={!collapsed} aria-label={collapsed ? t("expandSidebar") : t("collapseSidebar")} title={collapsed ? t("expandSidebar") : t("collapseSidebar")} className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-[color,background-color,opacity] hover:bg-accent hover:text-foreground collapsed:opacity-0 collapsed:group-hover/brand:opacity-100 collapsed:focus-visible:opacity-100">
            <PanelLeftClose className="size-4 collapsed:hidden" /><PanelLeftOpen className="hidden size-4 collapsed:block" />
          </button>
        </div>
        <NavigationTree key={activeSection ?? pathname} {...treeProps} collapsed={collapsed} />
        <Button variant="ghost" disabled={loggingOut} onClick={handleLogout} aria-label={t("logout")} className={cn("mt-1 justify-start px-3 text-muted-foreground", collapsed && "justify-center px-0")}><LogOut className="size-4 shrink-0" /><span className="collapsed:hidden">{t("logout")}</span></Button>
      </aside>
    </>
  );
}
