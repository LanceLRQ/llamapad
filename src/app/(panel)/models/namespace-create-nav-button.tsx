"use client";

import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { NamespaceCreateDialog } from "@/components/namespace-create-dialog";

/**
 * 模型页二级栏「＋新建命名空间」入口（阶段 4 D5）：贴着标题的小按钮 + 共享
 * 弹层。建完之后切到新空间的切片（此时是空的），而不是留在原分组不动——
 * 与文件页新建目录后跳进新目录的既有习惯一致，"刚建的东西建完就该看得见"。
 *
 * 这里推翻了 models/page.tsx 早前的说法（"二级栏不加新建入口，避免与设置页
 * 两个入口混淆"）：命名空间与文件夹解耦后，模型页是用户"边选空间边建模型"
 * 最高频的落脚点，逼着他们跳到设置页再绕回来才是真正的体验成本；两个入口
 * 但语义不冲突（这里是"顺手建一个就用"，设置页是"管理全部空间"），不构成
 * 用户会犯糊涂的重复。
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
        size="icon-sm"
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
