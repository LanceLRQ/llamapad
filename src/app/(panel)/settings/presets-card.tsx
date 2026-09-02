"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { BookOpen, Loader2, Pencil, SlidersHorizontal, Trash2 } from "lucide-react";

import type { ServerConfig } from "@/core/schemas";
import { apiFetch } from "@/lib/api";
import { builtinPresetServer, PARAM_PRESET_IDS, type ParamPresetId } from "@/lib/param-presets";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SettingTip } from "@/components/setting-tip";

/**
 * 设置页「参数预设」区块（任务 21 T12，client）：照 namespaces-card.tsx 的形态
 * （列表 + 行内改名 + 删除确认），动作完成后 router.refresh() 重取 page 数据。
 *
 * 列表 = 内置三档（lib/param-presets.ts 代码常量，只读）+ DB 里的用户预设
 * （server 侧 listPresets 装配初值，按 name 排序）。内置项单独列出是为了让
 * 「保守/平衡/全卸载」在这张卡里有处可查——它们跟着代码版本走、不落库，也
 * 因此没有改名/删除入口。
 *
 * 语义透出（与服务层一致）：
 * - 改名走 PATCH /api/v1/presets/:id，只改显示名（预设靠名字被人认出来，name 唯一）
 * - 删除走 DELETE /api/v1/presets/:id。预设的应用语义是**快照**（设计 §8.3：
 *   套用时把值拷进 model.overrides，之后两者再无关系），所以删除不影响已套用
 *   的模型配置——确认弹层里必须把这句说清楚，否则用户不敢删
 * - 本卡只做「管理」；套用与另存的入口在模型参数区（T11）与 README 推荐卡
 */

/** 一行预设数据（与 server/repo/presets.ts 的 ParamPreset 结构兼容，客户端不引 server 模块） */
export interface PresetEntry {
  id: number;
  name: string;
  server: Partial<ServerConfig>;
  source: PresetSource;
  /** source="readme" 时记来源仓库，展示为副标题、可回溯出处 */
  sourceRepo: string | null;
}

type PresetSource = "manual" | "readme" | "model";

/** 内置三档行（lib/param-presets.ts 是唯一真源，这里只负责摆出来） */
const BUILTIN_PRESETS: { id: ParamPresetId; server: Partial<ServerConfig> }[] = PARAM_PRESET_IDS.map(
  (id) => ({ id, server: builtinPresetServer(id) }),
);

/** 参数摘要：`temp 0.6 · top_p 0.95 · +3`——最多 3 项，其余折叠成计数。
 * 键名直接用 server 字段名：技术名词，编辑页表单与参数提示里也是这么展示的，
 * 不额外做 i18n 映射 */
function summarizeParams(server: Partial<ServerConfig>): string {
  const keys = Object.keys(server).sort();
  const head = keys.slice(0, 3).map((key) => `${key} ${String(server[key as keyof ServerConfig])}`);
  const rest = keys.length - head.length;
  return [...head, ...(rest > 0 ? [`+${rest}`] : [])].join(" · ");
}

/** 来源徽章的文案键（不用模板串拼 key：显式映射，键名拼错编译期就能看出来） */
function sourceLabelKey(source: PresetSource): string {
  if (source === "readme") return "sourceReadme";
  if (source === "model") return "sourceModel";
  return "sourceManual";
}

export function PresetsCard({ presets }: { presets: PresetEntry[] }) {
  const t = useTranslations("pages.settings.presets");
  const tc = useTranslations("common.paramPresets");
  const ts = useTranslations("pages.settings");
  const router = useRouter();

  const [renaming, setRenaming] = useState<PresetEntry | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);

  const [deleting, setDeleting] = useState<PresetEntry | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  /** 统一的错误文案：按状态码映射（服务端守卫为最终裁决） */
  function messageFor(status: number, fallback: string): string {
    if (status === 409) return t("errorConflict");
    if (status === 404) return t("errorNotFound");
    return fallback;
  }

  async function onConfirmRename() {
    if (renaming === null || renameBusy) return;
    const name = renameValue.trim();
    if (name === "" || name === renaming.name) return;
    setRenameBusy(true);
    setRenameError(null);
    const res = await apiFetch(`/api/v1/presets/${renaming.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }).catch(() => null);
    setRenameBusy(false);

    if (res === null) {
      setRenameError(ts("errorNetwork"));
      return;
    }
    if (res.ok) {
      setRenaming(null);
      router.refresh();
      return;
    }
    setRenameError(messageFor(res.status, ts("errorRequest")));
  }

  async function onConfirmDelete() {
    if (deleting === null || deleteBusy) return;
    setDeleteBusy(true);
    setDeleteError(null);
    const res = await apiFetch(`/api/v1/presets/${deleting.id}`, { method: "DELETE" }).catch(() => null);
    setDeleteBusy(false);

    if (res === null) {
      setDeleteError(ts("errorNetwork"));
      return;
    }
    if (res.ok) {
      setDeleting(null);
      router.refresh();
      return;
    }
    setDeleteError(messageFor(res.status, ts("errorRequest")));
  }

  return (
    <Card className="gap-0 py-0">
      <div className="flex flex-wrap items-center gap-2.5 border-b p-4">
        <SlidersHorizontal className="size-4 text-muted-foreground" />
        <div className="flex items-center gap-1">
          <h2 className="text-sm font-semibold">{t("title")}</h2>
          <SettingTip text={t("description")} />
        </div>
      </div>

      <div className="flex flex-col gap-3 p-4">
        <div className="max-h-72 overflow-y-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("colName")}</TableHead>
                <TableHead>{t("colParams")}</TableHead>
                <TableHead className="w-[110px]">{t("colSource")}</TableHead>
                <TableHead className="w-[150px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {/* 内置三档：只读，没有改名/删除入口。不列出来用户会以为「保守/平衡/
                  全卸载」是另一个系统的东西；参数值见 lib/param-presets.ts */}
              {BUILTIN_PRESETS.map((preset) => (
                <TableRow key={preset.id}>
                  <TableCell>
                    <span className="text-[13px] font-semibold" title={tc(`${preset.id}Hint`)}>
                      {tc(preset.id)}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-[13px] text-muted-foreground">
                    {summarizeParams(preset.server)}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{t("sourceBuiltin")}</Badge>
                  </TableCell>
                  <TableCell>
                    <span className="text-muted-foreground">—</span>
                  </TableCell>
                </TableRow>
              ))}
              {presets.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell>
                    <div className="flex flex-col items-start gap-0.5">
                      <span className="text-[13px] font-semibold">{entry.name}</span>
                      {entry.source === "readme" && entry.sourceRepo !== null && (
                        <Link
                          href="/models/repos"
                          title={t("sourceRepoHint")}
                          className="inline-flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground hover:underline"
                        >
                          <BookOpen className="size-3" />
                          {entry.sourceRepo}
                        </Link>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-[13px] text-muted-foreground">
                    {summarizeParams(entry.server)}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">{t(sourceLabelKey(entry.source))}</Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        title={t("renameButton")}
                        disabled={renaming !== null || deleting !== null}
                        onClick={() => {
                          setRenameValue(entry.name);
                          setRenameError(null);
                          setRenaming(entry);
                        }}
                      >
                        <Pencil className="size-3.5" />
                        {t("renameButton")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        title={t("deleteButton")}
                        disabled={renaming !== null || deleting !== null}
                        onClick={() => {
                          setDeleteError(null);
                          setDeleting(entry);
                        }}
                      >
                        <Trash2 className="size-3.5" />
                        {t("deleteButton")}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        {/* 预设的产出与去向：这张卡只管「看和删」，不在此新建（另存入口在参数区
            与 README 推荐卡）；快照语义一并钉住，跟删除确认里的说法保持一致 */}
        <p className="text-xs text-muted-foreground">{t("sourceHint")}</p>
      </div>

      {/* 重命名 Dialog */}
      <Dialog
        open={renaming !== null}
        onOpenChange={(open) => {
          if (!open && !renameBusy) setRenaming(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("renameTitle")}</DialogTitle>
            {/* 只改显示名，不碰任何模型配置——低风险操作，保留灰色小字 */}
            <DialogDescription>{t("renameDescription")}</DialogDescription>
          </DialogHeader>
          {/* 不用 font-mono：预设名是给人看的标签（如「Qwen3 思考模式」），与
              参数区「另存为预设」的命名输入框同款；maxLength 对齐仓储的 MAX_NAME */}
          <Input
            value={renameValue}
            maxLength={64}
            onChange={(e) => setRenameValue(e.target.value)}
            aria-invalid={renameError !== null}
          />
          {renameError && <p className="text-xs text-destructive">{renameError}</p>}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={renameBusy} />}>
              {ts("cancel")}
            </DialogClose>
            <Button
              disabled={renameBusy || renameValue.trim() === "" || renameValue.trim() === renaming?.name}
              onClick={onConfirmRename}
            >
              {renameBusy && <Loader2 className="animate-spin" />}
              {renameBusy ? t("renaming") : t("renameConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认 Dialog */}
      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open && !deleteBusy) setDeleting(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("deleteTitle")}</DialogTitle>
            <DialogDescription>
              <span className="break-all font-mono text-xs">{deleting?.name}</span>
            </DialogDescription>
          </DialogHeader>
          {/* A 级：不可逆删除记录；快照语义是用户敢不敢删的关键，不做灰色小字 */}
          <p className="text-sm text-foreground">{t("deleteDescription")}</p>
          {deleteError && <p className="text-xs text-destructive">{deleteError}</p>}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={deleteBusy} />}>
              {ts("cancel")}
            </DialogClose>
            <Button variant="destructive" disabled={deleteBusy} onClick={onConfirmDelete}>
              {deleteBusy && <Loader2 className="animate-spin" />}
              {deleteBusy ? t("deleting") : t("deleteConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
