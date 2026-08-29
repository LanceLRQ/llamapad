"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { CheckCircle2, Loader2, Stethoscope, TriangleAlert, XCircle } from "lucide-react";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";

/**
 * 设置页「环境自检」卡片（UX P1 U18，client；照抄 hf-card.tsx 的
 * 按钮 → apiFetch → 双态提示结构）：「开始检查」按钮触发
 * GET /api/v1/doctor，展示六项固定顺序的检查结果（ok 绿勾 / warn 琥珀 /
 * fail 红叉 + detail 灰字）。挂在 Settings 页第一张卡——环境问题优先于配置。
 */

type DoctorStatus = "ok" | "warn" | "fail";

/** 响应形状（与 server/doctor.ts 的 DoctorItem 同构，客户端不引 server 模块） */
interface DoctorItemView {
  id: string;
  status: DoctorStatus;
  detail?: string;
}

/** 六项固定 id，用于取 i18n 标签（顺序与后端返回一致，此处仅做标签映射，不依赖顺序） */
const ITEM_LABEL_KEYS: Record<string, string> = {
  docker: "itemDocker",
  modelsDir: "itemModelsDir",
  pathMap: "itemPathMap",
  gpu: "itemGpu",
  hf: "itemHf",
  disk: "itemDisk",
};

export function DoctorCard() {
  const t = useTranslations("pages.settings.doctor");
  const tCommon = useTranslations("pages.settings");

  const [checking, setChecking] = useState(false);
  const [items, setItems] = useState<DoctorItemView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onCheck() {
    if (checking) return;
    setChecking(true);
    setError(null);
    const res = await apiFetch("/api/v1/doctor", { cache: "no-store" }).catch(() => null);
    setChecking(false);
    if (res === null) {
      setError(tCommon("errorNetwork"));
      return;
    }
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(data?.error ?? tCommon("errorRequest"));
      return;
    }
    const data = (await res.json()) as { items: DoctorItemView[] };
    setItems(data.items);
  }

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2.5 border-b px-4 py-3">
        <Stethoscope className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">{t("title")}</h2>
      </div>

      <div className="flex flex-col gap-3 px-4 py-3.5">
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" disabled={checking} onClick={onCheck}>
            {checking ? <Loader2 className="size-3.5 animate-spin" /> : <Stethoscope className="size-3.5" />}
            {checking ? t("checking") : t("checkButton")}
          </Button>
          {/* 上下文感知的条件提示（复核修正）：只在「还没检查过」时告知点了会查哪六项，
              是首次进入的引导，检查过一次后自动消失，比常驻 `?` 更贴合时机 */}
          {items === null && !checking && (
            <span className="text-xs text-muted-foreground">{t("hint")}</span>
          )}
        </div>

        {error && (
          <p className="flex items-center gap-1.5 text-xs text-destructive">
            <XCircle className="size-3.5 shrink-0" />
            {error}
          </p>
        )}

        {items !== null && (
          <ul className="flex flex-col gap-1.5">
            {items.map((item) => (
              <li key={item.id} className="flex items-start gap-2 text-sm">
                {item.status === "ok" && (
                  <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                )}
                {item.status === "warn" && (
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                )}
                {item.status === "fail" && (
                  <XCircle className="mt-0.5 size-3.5 shrink-0 text-destructive" />
                )}
                <span className="min-w-0">
                  <span className="font-medium">{t(ITEM_LABEL_KEYS[item.id] ?? item.id)}</span>
                  {item.detail && <span className="ml-1.5 text-xs text-muted-foreground">{item.detail}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
