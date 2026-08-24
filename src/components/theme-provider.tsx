"use client";

import { ThemeProvider as NextThemes } from "next-themes";

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // 默认亮色（首次访问不跟随系统）；enableSystem 保留"跟随系统"作为手动可选的第三态
  return (
    <NextThemes attribute="class" defaultTheme="light" enableSystem>
      {children}
    </NextThemes>
  );
}
