"use client";

import { ThemeProvider as NextThemes } from "next-themes";

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // 跟随系统（视觉设计规范第 3 条：默认亮色，prefers-color-scheme: dark 时自动切暗色）；
  // next-themes 的 system 档正是「亮色为底、系统偏好暗色时切暗」，顶栏仍可手动覆盖。
  return (
    <NextThemes attribute="class" defaultTheme="system" enableSystem>
      {children}
    </NextThemes>
  );
}
