import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

import packageJson from "./package.json";

const withNextIntl = createNextIntlPlugin();

const nextConfig: NextConfig = {
  output: "standalone",
  // 侧栏（client 组件）要展示版本号，但不能直接 import package.json 进客户端
  // bundle（整份 package.json 没必要随页面下发）——经 env 注入只带出这一个字段
  env: {
    NEXT_PUBLIC_APP_VERSION: packageJson.version,
  },
  // dockerode 及其依赖链（docker-modem → ssh2）含非 ESM 资产，Turbopack 无法打包，外置为运行时 require
  serverExternalPackages: ["better-sqlite3", "dockerode", "ssh2"],
  // 运行时动态路径（PANEL_DB/PANEL_CONFIG）导致产物追踪退化为全项目打包，
  // 显式排除内部资料与运行数据，防止 dev-data/panel.db 等进入镜像产物
  outputFileTracingExcludes: {
    "*": [
      "./CLAUDE.md",
      "./CLAUDE.local.md",
      "./AGENTS.md",
      "./.claude/**",
      "./.git/**",
      "./docs/**",
      "./dev-data/**",
      "./config/**",
      "./.DS_Store",
    ],
  },
};

export default withNextIntl(nextConfig);
