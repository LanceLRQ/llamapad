import Link from "next/link";
import { CheckCircle2, Circle, ListChecks } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { OnboardingStep } from "@/lib/onboarding";

/**
 * 首启动引导卡（UX P1 U22）：纯展示，四步状态由 page.tsx 用 onboardingSteps()
 * 算好传入——卡片本身不读 db，不新增内部 fetch。isOnboardingComplete 时
 * page.tsx 直接不渲染本组件（老用户永不见此卡），故这里不用再判一次。
 */
export async function OnboardingCard({ steps }: { steps: OnboardingStep[] }) {
  const t = await getTranslations("pages.overview.onboarding");

  return (
    <Card>
      <CardContent className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <ListChecks className="size-3.5 text-muted-foreground" />
          <span className="text-xs font-semibold">{t("title")}</span>
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
