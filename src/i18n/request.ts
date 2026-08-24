import { cookies } from "next/headers";
import { getRequestConfig } from "next-intl/server";

import { LOCALE_COOKIE, resolveLocale } from "./locales";

/**
 * next-intl 请求配置（无路由 / cookie 模式，见 locales.ts 的模式说明）。
 *
 * 每个请求读 cookie `llamapad_locale` 决定 locale（非法值回退 zh），按 locale 动态
 * import 对应 messages —— 未选中的语言包不进该请求的 bundle（next-intl 官方推荐的
 * 分包写法，Turbopack 支持目录前缀的动态 import）。
 *
 * 注意：读 cookies() 使全部页面走动态渲染——面板本就整墙在登录后且 (panel) 层已
 * force-dynamic，无静态化诉求，无额外代价。
 */
export default getRequestConfig(async () => {
  const cookieValue = (await cookies()).get(LOCALE_COOKIE)?.value;
  const locale = resolveLocale(cookieValue);

  return {
    locale,
    messages: (await import(`./messages/${locale}.json`)).default,
  };
});
