"use client";

import { TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";

import type { GpuDevice, NvidiaStatus } from "@/server/metrics/nvidiaSmi";
import {
  isAscendingDeviceList,
  parseSelectedDevices,
  toggleSelectedDevice,
} from "@/lib/gpu-selection";
import { toContainerGpuIndex } from "@/lib/gpu-visibility";
import { gpuMemoryPercent, missingSelectedDevices } from "@/lib/gpu-device-picker";
import { toGib } from "@/lib/metric-card-value";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";

/**
 * `device=` 挑卡区：勾选式卡片列表 + 常驻手动文本框（GPU 挑卡卡片化批次）。
 *
 * 受控组件：裸列表字符串（不带 `device=` 前缀）是唯一真源，勾选态由
 * `parseSelectedDevices` 现算，组件自己不持有任何可派生 state——同步规则
 * 见 lib/gpu-selection.ts 头注释。设备列表与探测状态由父组件传入（父组件
 * 已经有那个 useEffect），本组件不 fetch。
 */
export interface GpuDevicePickerProps {
  /** 裸列表字符串（不带 `device=` 前缀），如 "0,2" */
  value: string;
  onChange: (value: string) => void;
  /** 整机探测到的 GPU 列表（宿主机视角，未按当前 gpu 配置过滤——挑卡本身就是在从这份全量里选） */
  devices: readonly GpuDevice[];
  /** nvidia-smi 探测状态：决定列表是否渲染与空态文案 */
  status: NvidiaStatus;
  /** 字段级校验错误（zod 正则），只用于给手动输入框打 aria-invalid，文案由外层 FieldShell 渲染，这里不重复 */
  invalid?: boolean;
  className?: string;
}

export function GpuDevicePicker({
  value,
  onChange,
  devices,
  status,
  invalid,
  className,
}: GpuDevicePickerProps) {
  const t = useTranslations("pages.modelEdit");

  const selected = parseSelectedDevices(value);
  const missing = missingSelectedDevices(
    selected,
    devices.map((d) => d.index),
  );
  const ascending = isAscendingDeviceList(value);
  // toContainerGpuIndex 认的是完整的 docker.gpu 形态（"device=0,2"），
  // 草稿只存裸列表，拼前缀是这里的职责，不属于 gpu-selection.ts
  const gpuForTranslation = `device=${value}`;

  // available 但一张卡都没探测到时，与 unavailable 同一套空态文案
  // （devices.length === 0 的两种成因——真没有卡 / 还没采到——用户不需要分辨）
  const showList = status === "available" && devices.length > 0;

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {!showList && (
        <p className="text-xs text-muted-foreground">
          {status === "probing" ? t("gpuPickerProbing") : t("gpuPickerUnavailable")}
        </p>
      )}

      {showList && (
        <div className="flex flex-col gap-1">
          {devices.map((device) => (
            <DeviceRow
              key={device.index}
              device={device}
              checked={selected.includes(device.index)}
              containerIndex={toContainerGpuIndex(device.index, gpuForTranslation)}
              onToggle={(on) => onChange(toggleSelectedDevice(value, device.index, on))}
            />
          ))}
          {missing.map((index) => (
            <MissingDeviceRow
              key={index}
              index={index}
              onRemove={() => onChange(toggleSelectedDevice(value, index, false))}
            />
          ))}
        </div>
      )}

      {/* 手动编辑常驻：GUI 只是方便直观选择，不取代手填能力（无 GPU 探测/纯
          CPU 部署时这是唯一的编辑出口，见组件头注释） */}
      <div className="flex items-center gap-1.5">
        <span className="shrink-0 font-mono text-xs text-muted-foreground">device=</span>
        <Input
          className="font-mono"
          placeholder={t("gpuDevicePlaceholder")}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={invalid || undefined}
        />
      </div>

      {!ascending && (
        <p className="flex items-start gap-1 text-xs leading-snug text-amber-700 dark:text-amber-400">
          <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden />
          <span>{t("gpuPickerNonAscending")}</span>
        </p>
      )}

      <p
        className={cn(
          "text-[11px]",
          selected.length === 0
            ? "text-amber-700 dark:text-amber-400"
            : "text-muted-foreground",
        )}
      >
        {selected.length === 0
          ? t("gpuPickerNoneSelected")
          : t("gpuPickerSelectedCount", { count: selected.length })}
      </p>
    </div>
  );
}

/** 一行一卡：勾选 + 编号 + 型号（可空）+ 显存占用条 + 读数 + 选中态容器内编号徽标 */
function DeviceRow({
  device,
  checked,
  containerIndex,
  onToggle,
}: {
  device: GpuDevice;
  checked: boolean;
  containerIndex: number;
  onToggle: (checked: boolean) => void;
}) {
  const percent = gpuMemoryPercent(device.memUsedMib, device.memTotalMib);
  return (
    <label
      className={cn(
        "flex min-w-0 items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs transition-colors",
        checked ? "border-primary/40 bg-primary/[0.06]" : "border-border",
      )}
    >
      <Checkbox checked={checked} onCheckedChange={(v) => onToggle(v === true)} />
      <span className="shrink-0 font-mono font-medium">GPU {device.index}</span>
      {/* 型号名与显存条共享剩余空间：名字可截断、条可收窄，勾选框/编号/读数
          三样在窄屏下始终整段可见（宽度约束见外层 flex 与本容器的 min-w-0） */}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {device.name !== null && (
          <span className="min-w-0 shrink truncate text-muted-foreground">{device.name}</span>
        )}
        <span className="h-1.5 min-w-10 flex-1 overflow-hidden rounded-full bg-foreground/10">
          <span
            className="block h-full rounded-full bg-primary/70 transition-[width] duration-300"
            style={{ width: `${percent}%` }}
          />
        </span>
      </div>
      <span className="shrink-0 font-mono text-muted-foreground">
        {toGib(device.memUsedMib)} / {toGib(device.memTotalMib)} G
      </span>
      {checked && (
        <Badge
          variant="outline"
          className="h-4 shrink-0 gap-0 border-primary/30 bg-primary/10 px-1 font-mono text-[10px] leading-none text-primary"
        >
          CUDA{containerIndex}
        </Badge>
      )}
    </label>
  );
}

/**
 * 配置里有、机器上没有的卡：绝不静默丢弃——用户会以为面板把他的配置改了。
 * 恒为选中态（能出现在这里就是因为它在 selected 集合里），可取消以从
 * 列表里移除。样式与正常行区分（虚线边框 + amber），但不只靠颜色——
 * 图标 + 文字同时说明"这张卡不存在"。
 */
function MissingDeviceRow({ index, onRemove }: { index: number; onRemove: () => void }) {
  const t = useTranslations("pages.modelEdit");
  return (
    <label className="flex min-w-0 items-center gap-2 rounded-lg border border-dashed border-amber-500/40 bg-amber-500/5 px-2.5 py-1.5 text-xs">
      <Checkbox checked onCheckedChange={(v) => v !== true && onRemove()} />
      <span className="shrink-0 font-mono font-medium">GPU {index}</span>
      <span className="flex min-w-0 flex-1 items-center gap-1 text-amber-700 dark:text-amber-400">
        <TriangleAlert className="size-3 shrink-0" aria-hidden />
        <span className="truncate">{t("gpuPickerMissingDevice")}</span>
      </span>
    </label>
  );
}
