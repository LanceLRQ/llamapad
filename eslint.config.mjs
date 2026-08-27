import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // 第三方工具目录（.gitignore 里已忽略）：superpowers 技能包自带的脚本不是本项目源码，
    // 用的也是另一套风格（CJS require、catch(e) 不用），不该由本仓 lint 规则裁决
    ".claude/**",
  ]),
  {
    rules: {
      // `_` 前缀 = 刻意不使用（解构丢弃字段的惯用写法），不报未使用
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
]);

export default eslintConfig;
