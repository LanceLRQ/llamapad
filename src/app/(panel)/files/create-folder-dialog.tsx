"use client";

import { useRouter } from "next/navigation";

import { CreateFolderDialog as SharedCreateFolderDialog } from "@/components/create-folder-dialog";

/**
 * 文件页专属包装（阶段 4 D1 起，弹层本体抽到 @/components/create-folder-dialog
 * 供向导共用）：这里只多做一件事——新建成功后跳到新目录，而不是停在原地，
 * 与改名成功后的既有跳转习惯一致。这个"建完去哪"的差异正是当初没有直接
 * 把整个组件搬去 components/ 的原因，见共享组件顶部注释。
 */
export function CreateFolderDialog({ parentPath }: { parentPath: string }) {
  const router = useRouter();
  return (
    <SharedCreateFolderDialog
      parentPath={parentPath}
      onCreated={(path) => router.push(`/files?path=${encodeURIComponent(path)}`)}
    />
  );
}
