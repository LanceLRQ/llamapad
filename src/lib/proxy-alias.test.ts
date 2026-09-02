import { describe, expect, it } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import { LLAMA_PROXY_ALIAS, LLAMA_PROXY_ROUTE, llamaProxyRewrites } from "./proxy-alias";

/**
 * 推理中转短地址别名的守卫。三条规则都不是在测「常量等于字面量」，
 * 而是钉住三个改别处才会踩到的坑：
 * 1. 真实路由被改名 / 移走 → 别名静默悬空（rewrite 指向不存在的 destination
 *    不会报错，只会在请求时落 404，而没人会想起来去试那个短地址）
 * 2. 有人在 app 下新建了同名顶层段 → 两者抢同一个 URL
 * 3. 根入口那条规则被当成冗余删掉 → `:path*` 匹配不到零段，
 *    `/llama-proxy` 本身立刻 404（真实路由特意用可选 catch-all 就是为了它）
 */

const appRoot = path.join(process.cwd(), "src", "app");

/** app 目录下所有字面顶层 URL 段：穿透路由组 `(x)`，跳过私有 `_x` 与动态 `[x]` */
function topLevelUrlSegments(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("_")) continue;
    if (entry.name.startsWith("[")) continue;
    if (entry.name.startsWith("(") && entry.name.endsWith(")")) {
      out.push(...topLevelUrlSegments(path.join(dir, entry.name)));
      continue;
    }
    out.push(entry.name);
  }
  return out;
}

describe("llamaProxyRewrites", () => {
  const rules = llamaProxyRewrites();

  it("产出带路径段与根入口两条规则", () => {
    expect(rules).toEqual([
      { source: `${LLAMA_PROXY_ALIAS}/:path*`, destination: `${LLAMA_PROXY_ROUTE}/:path*` },
      { source: LLAMA_PROXY_ALIAS, destination: LLAMA_PROXY_ROUTE },
    ]);
  });

  it("根入口单独成条——`:path*` 匹配不到零段", () => {
    const bare = rules.filter((rule) => !rule.source.includes(":path"));
    expect(bare).toHaveLength(1);
    expect(bare[0].destination).toBe(LLAMA_PROXY_ROUTE);
  });

  it("destination 指向真实存在的可选 catch-all 路由", () => {
    const routeFile = path.join(
      process.cwd(),
      "src",
      "app",
      ...LLAMA_PROXY_ROUTE.split("/").filter(Boolean),
      "[[...path]]",
      "route.ts",
    );
    expect(existsSync(routeFile)).toBe(true);
  });

  it("别名前缀不与 app 的任何顶层 URL 段冲突", () => {
    const alias = LLAMA_PROXY_ALIAS.replace(/^\//, "");
    expect(topLevelUrlSegments(appRoot)).not.toContain(alias);
  });

  it("每条规则的 source 都落在别名前缀下、destination 都落在真实路由下", () => {
    for (const rule of rules) {
      expect(rule.source.startsWith(LLAMA_PROXY_ALIAS)).toBe(true);
      expect(rule.destination.startsWith(LLAMA_PROXY_ROUTE)).toBe(true);
    }
  });
});
