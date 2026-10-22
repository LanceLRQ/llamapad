"use client";

import { useState } from "react";
import Link from "next/link";
import { CheckCircle2, Circle, ListChecks, X } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { OnboardingStep } from "@/lib/onboarding";

/**
 * 首启动悬浮引导卡：四步状态由 page.tsx 用 onboardingSteps()
 * 算好传入——卡片本身不读 db，不新增内部 fetch。isOnboardingComplete 时
 * page.tsx 直接不渲染本组件（老用户永不见此卡），故这里不用再判一次。
 */
export function OnboardingCard({ steps }: { steps: OnboardingStep[] }) {
  const t = useTranslations("pages.overview.onboarding");
  const [open, setOpen] = useState(true);

  if (!open) {
    return (
      <Button
        variant="outline"
        size="sm"
        className="fixed right-6 bottom-14 z-40 shadow-lg"
        aria-label={t("open")}
        onClick={() => setOpen(true)}
      >
        <ListChecks className="size-3.5" />
        {t("title")}
      </Button>
    );
  }

  return (
    <Card
      className="fixed right-6 bottom-14 z-40 max-h-[calc(100dvh-6rem)] w-[min(380px,calc(100vw-3rem))] overflow-y-auto shadow-xl"
      role="region"
      aria-label={t("title")}
    >
      <CardContent className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <ListChecks className="size-3.5 text-muted-foreground" />
          <span className="text-xs font-semibold">{t("title")}</span>
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto"
            aria-label={t("close")}
            title={t("close")}
            onClick={() => setOpen(false)}
          >
            <X className="size-3.5" />
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">{t("hint")}</p>

        <ul className="mt-1 flex flex-col">
          {steps.map((step) => (
            <li
              key={step.id}
              className="flex items-center gap-2.5 border-b py-2 text-xs last:border-b-0"
            >
              <StepDot step={step} />
              <span className="min-w-0 flex-1 truncate">{t(`steps.${step.id}.title`)}</span>
              <Button
                size="xs"
                variant={step.current ? "default" : "outline"}
                nativeButton={false}
                render={<Link href={step.href} />}
              >
                {t(`steps.${step.id}.action`)}
              </Button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/** 状态圈：done 绿勾 / current 主色环 / todo 灰圈 */
function StepDot({ step }: { step: OnboardingStep }) {
  if (step.done) return <CheckCircle2 className="size-4 shrink-0 text-accent-green" />;
  if (step.current) {
    return (
      <span
        aria-hidden
        className="size-4 shrink-0 rounded-full border-2 border-primary"
      />
    );
  }
  return <Circle className="size-4 shrink-0 text-muted-foreground/40" />;
}
