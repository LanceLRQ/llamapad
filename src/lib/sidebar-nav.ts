import { DOWNLOADS_VIEWS, resolveDownloadsView } from "./downloads-view";
import { LOGS_TABS, resolveLogsTab } from "./logs-tabs";
import { MODELS_TABS, resolveModelsTab } from "./models-tabs";
import { SETTINGS_TABS, resolveSettingsTab } from "./settings-tabs";

export type SidebarSection = "models" | "downloads" | "logs" | "settings";

export interface SidebarChild {
  key: string;
  href: string;
  labelKey: string;
  active: boolean;
}

/** 模块切换不带入其他页面的 query；同模块内保留搜索词与模型选择。 */
export function sidebarChildren(section: SidebarSection, pathname: string, search: string): SidebarChild[] {
  const root = `/${section}`;
  const active = pathname === root || pathname.startsWith(`${root}/`);
  const params = new URLSearchParams(pathname === root ? search : "");
  const queryHref = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    next.set(key, value);
    return `${root}?${next.toString()}`;
  };

  switch (section) {
    case "models":
      return MODELS_TABS.map(({ key, href }) => ({ key, href, labelKey: `pages.models.tabs.${key}.name`, active: active && key === resolveModelsTab(pathname) }));
    case "settings":
      return SETTINGS_TABS.map(({ key }) => ({ key, href: queryHref("tab", key), labelKey: `pages.settings.groups.${key}.name`, active: active && key === resolveSettingsTab(params.get("tab") ?? undefined) }));
    case "logs":
      return LOGS_TABS.map(({ key }) => ({ key, href: queryHref("tab", key), labelKey: `pages.logs.groups.${key}.name`, active: active && key === resolveLogsTab(params.get("tab") ?? undefined) }));
    case "downloads": {
      const labels = { queue: "navQueue", downloading: "navDownloading", pending: "navPending", paused: "navPaused", failed: "navFailed", history: "navHistory" };
      return DOWNLOADS_VIEWS.map((key) => ({ key, href: queryHref("view", key), labelKey: `pages.downloads.${labels[key]}`, active: active && key === resolveDownloadsView(params.get("view") ?? undefined) }));
    }
  }
}
