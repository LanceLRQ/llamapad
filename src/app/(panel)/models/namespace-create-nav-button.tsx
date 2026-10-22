"use client";

import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { NamespaceCreateDialog } from "@/components/namespace-create-dialog";

/**
 * 命名空间筛选框旁的新建入口，复用共享弹层。
 * 建完后切到新空间，增删改的完整管理仍放在设置页。
 */
export function NamespaceCreateNavButton() {
  const t = useTranslations("pages.modelsNew");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        title={t("namespaceCreateTitle")}
        aria-label={t("namespaceCreateTitle")}
        onClick={() => setOpen(true)}
      >
        <Plus className="size-3.5" />
      </Button>
      <NamespaceCreateDialog
        open={open}
        onOpenChange={setOpen}
        onCreated={(name) => {
          const params = new URLSearchParams(searchParams.toString());
          params.set("ns", name);
          router.push(`${pathname}?${params.toString()}`);
        }}
      />
    </>
  );
}
