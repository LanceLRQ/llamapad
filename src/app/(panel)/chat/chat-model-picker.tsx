"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import {
  RunningModelPicker,
  useRunningModels,
  type RunningModelsSnapshot,
} from "@/components/running-model-picker";
import { buildModelOptions, chatHref, isSelectionGone } from "@/lib/model-picker";

/**
 * Chat 页页头的模型下拉框（D11）：切换写进 URL，由服务端重新渲染参数栏与端口。
 * 只有一个模型在跑时不显示。
 *
 * 选中的模型被停掉后刷新页面：服务端按 resolveChatModel 回落到默认模型并显示提示，
 * 对话随 ChatPanel 的 key 一起清空——停掉的模型没法接着聊。全部停止时刷新回引导卡。
 */
export function ChatModelPicker({
  initial,
  selected,
}: {
  initial: RunningModelsSnapshot;
  selected: string;
}) {
  const router = useRouter();
  const { models, defaultModel, synced } = useRunningModels(initial);

  const gone = synced && isSelectionGone(selected, models);
  useEffect(() => {
    if (gone) router.refresh();
  }, [gone, router]);

  if (models.length < 2) return null;
  return (
    <RunningModelPicker
      options={buildModelOptions(models, defaultModel, selected)}
      value={selected}
      onChange={(model) => router.push(chatHref(model))}
    />
  );
}
