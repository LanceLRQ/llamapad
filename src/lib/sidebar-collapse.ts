/**
 * 侧栏折叠态（纯逻辑 + 外部 store）
 *
 * 真源是 <html data-sidebar>，由首屏内联脚本在水合前打上，localStorage 只是它的
 * 持久化副本。宽度与标签显隐全靠 CSS 读这个属性（globals.css 的 collapsed 变体），
 * React 侧只用 store 取值填 aria/title——首帧拿不到 localStorage，用 state 控宽度
 * 会让折叠态刷新时先闪一下 236px。
 */

export const SIDEBAR_STORAGE_KEY = "llamapad_sidebar";
export const SIDEBAR_COLLAPSED_VALUE = "collapsed";
export const SIDEBAR_ATTR = "data-sidebar";

/** 首屏内联脚本：由上面三个常量拼出，不手抄字面量——脚本与常量漂移是这类
 *  方案最典型的坑（改了 key 忘了改脚本，折叠态就永远读不回来） */
export const SIDEBAR_INIT_SCRIPT =
  `try{if(localStorage.getItem("${SIDEBAR_STORAGE_KEY}")==="${SIDEBAR_COLLAPSED_VALUE}")` +
  `document.documentElement.setAttribute("${SIDEBAR_ATTR}","${SIDEBAR_COLLAPSED_VALUE}")}catch(e){}`;

const listeners = new Set<() => void>();

export const sidebarCollapseStore = {
  subscribe(onChange: () => void): () => void {
    listeners.add(onChange);
    return () => {
      listeners.delete(onChange);
    };
  },
  getSnapshot: (): boolean =>
    document.documentElement.getAttribute(SIDEBAR_ATTR) === SIDEBAR_COLLAPSED_VALUE,
  /** 服务端不知道用户的 localStorage，恒按展开——首帧只影响 aria/title，不影响布局 */
  getServerSnapshot: (): boolean => false,
  toggle(): void {
    const root = document.documentElement;
    const next = root.getAttribute(SIDEBAR_ATTR) !== SIDEBAR_COLLAPSED_VALUE;
    if (next) root.setAttribute(SIDEBAR_ATTR, SIDEBAR_COLLAPSED_VALUE);
    else root.removeAttribute(SIDEBAR_ATTR);
    try {
      if (next) localStorage.setItem(SIDEBAR_STORAGE_KEY, SIDEBAR_COLLAPSED_VALUE);
      else localStorage.removeItem(SIDEBAR_STORAGE_KEY);
    } catch {
      // 隐私模式 / 存储被禁：本次会话照样能折叠，只是记不住，不该因此报错
    }
    for (const listener of listeners) listener();
  },
};
