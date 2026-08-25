import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages, getTranslations } from "next-intl/server";
import "./globals.css";

import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/toast";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// html lang 与站点描述随 locale（cookie）变化 → 动态生成 metadata
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("common");
  return { title: "llamapad", description: t("metaDescription") };
}

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // 无路由模式：locale 由 src/i18n/request.ts 读 cookie 决定（默认 zh）
  const locale = await getLocale();
  const messages = await getMessages();

  return (
    <html
      lang={locale === "zh" ? "zh-CN" : locale}
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col">
        <ThemeProvider>
          {/* client 组件（sidebar/topbar/login-form 等）经 provider 取得 messages */}
          <NextIntlClientProvider messages={messages}>
            {children}
          </NextIntlClientProvider>
          {/* 全局 toast 出口（命令式 toast.* 由各 client 组件调用） */}
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
