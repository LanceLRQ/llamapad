"use client";

import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * 可增删的多行字符串编辑器（从 image-card.tsx 拆出，纯展示组件）：
 * 自定义镜像卡片的 entrypoint/extra_args/args_override/env 四个数组字段共用。
 */
export function StringArrayField({
  label,
  hint,
  values,
  addLabel,
  onChange,
}: {
  label: string;
  hint?: string;
  values: string[];
  addLabel: string;
  onChange: (next: string[]) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-xs font-medium">{label}</Label>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {values.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {values.map((value, index) => (
            <div key={index} className="flex items-center gap-1.5">
              <Input
                className="font-mono text-xs"
                value={value}
                onChange={(e) => {
                  const next = [...values];
                  next[index] = e.target.value;
                  onChange(next);
                }}
              />
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => onChange(values.filter((_, i) => i !== index))}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
      <Button variant="outline" size="sm" className="w-fit" onClick={() => onChange([...values, ""])}>
        <Plus className="size-3.5" />
        {addLabel}
      </Button>
    </div>
  );
}
