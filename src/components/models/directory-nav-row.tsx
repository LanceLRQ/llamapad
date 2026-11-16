import { Folder, FolderOpen } from "lucide-react";
import { cn } from "@/lib/utils";

/** 文件选择器和扫描目录浏览器共用的目录导航行。 */
export function DirectoryNavRow({
  label,
  active = false,
  depth = 0,
  count,
  onClick,
}: {
  label: string;
  active?: boolean;
  depth?: number;
  count?: number;
  onClick: () => void;
}) {
  const Icon = active ? FolderOpen : Folder;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active || undefined}
      style={{ paddingLeft: 8 + depth * 12 }}
      className={cn(
        "flex h-[30px] w-full min-w-0 items-center gap-1.5 rounded-md pr-2 text-left text-[12.5px] transition-colors hover:bg-accent",
        active && "bg-primary/12 font-medium text-primary",
      )}
    >
      <Icon className={cn("size-3.5 shrink-0 text-muted-foreground", active && "text-primary")} />
      <span className="min-w-0 flex-1 truncate" title={label}>{label}</span>
      {count !== undefined && <span className="text-[11px] text-muted-foreground">{count}</span>}
    </button>
  );
}
