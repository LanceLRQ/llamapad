"use client";

import { useRouter } from "next/navigation";

import {
  RunningModelPicker,
  useRunningModels,
  type RunningModelsSnapshot,
} from "@/components/running-model-picker";
import { buildModelOptions, FOLLOW_DEFAULT, logsHref, showLogsPicker } from "@/lib/model-picker";

/**
 * 容器日志组页头的模型下拉框（D12）。selected 为 null 表示跟随默认模型。
 *
 * 与 Chat 页不同，固定的模型停止后不自动切走：终端里它最后的日志正是排查要看的，
 * 选项标「已停止」即可；模型再次启动时日志流自己会接上。
 */
export function LogsModelPicker({
  initial,
  selected,
}: {
  initial: RunningModelsSnapshot;
  selected: string | null;
}) {
  const router = useRouter();
  const { models, defaultModel } = useRunningModels(initial);

  if (!showLogsPicker(models.length, selected)) return null;
  return (
    <RunningModelPicker
      options={buildModelOptions(models, defaultModel, selected)}
      value={selected ?? FOLLOW_DEFAULT}
      followDefault
      onChange={(value) => router.push(logsHref(value === FOLLOW_DEFAULT ? null : value))}
    />
  );
}
