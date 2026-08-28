"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { FileDown, Loader2, PackagePlus, Upload } from "lucide-react";

import { formatSize } from "@/lib/format";
import type { PickerItem } from "@/lib/model-file-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch } from "@/lib/api";
import { ModelFilePicker } from "@/components/models/model-file-picker";

/**
 * 设置页「导入与备份」区块（M2 Task 8，client；T4 增导入重指）：
 * - 导出全集：POST /api/v1/export → 服务端写 zip，回显路径与大小
 * - 自动快照开关：PUT /api/v1/settings/auto_snapshot（初始值由 server 传入）
 * - 导入表单：粘贴单 YAML 文本（llamapad / bash 格式）+ 冲突策略 →
 *   先 POST /api/v1/import/preview 预检；全部命中直接进 POST /api/v1/import，
 *   有缺失则展示重指表格（复用 ModelFilePicker），确认后把选择结果作为
 *   remap 一并提交（未选择的行按"跳过"保留原路径落库）
 * - bash 迁移：把 llama-launcher configs 目录的 default.yaml 与 models/*.yaml
 *   逐个添加为 {name, content} → POST /api/v1/migrate/bash（不经预检，规格
 *   §4 的重指只覆盖单 YAML 导入这一路）
 */

/** 导入/迁移结果（两个接口同构，import 少 files 维度） */
interface ImportResult {
  imported: string[];
  skipped: string[];
  renamed: { from: string; to: string }[];
  warnings: string[];
  defaultsApplied?: boolean;
}

/** POST /api/v1/import/preview 的单个模型预检结果 */
interface PreviewModel {
  name: string;
  gguf_file: string;
  mmproj_file: string | null;
  ggufMissing: boolean;
  mmprojMissing: boolean;
}

/** 一行的重指选择：字段缺席 = 该字段保留原路径（"跳过"） */
type RemapChoice = { gguf_file?: string; mmproj_file?: string };

export function ImportExportCard({
  autoSnapshotInitial,
  pickerItems,
}: {
  autoSnapshotInitial: boolean;
  /** 重指表格的文件选择弹层候选项（T4）：与模型编辑页同款，server 侧扫盘装配 */
  pickerItems: PickerItem[];
}) {
  const t = useTranslations("pages.settings");

  // 导出
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  // 自动快照开关
  const [autoSnapshot, setAutoSnapshot] = useState(autoSnapshotInitial);
  const [snapshotBusy, setSnapshotBusy] = useState(false);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);

  // 导入表单
  const [importContent, setImportContent] = useState("");
  const [importFormat, setImportFormat] = useState<"llamapad" | "bash">("llamapad");
  const [strategy, setStrategy] = useState<"skip" | "rename" | "overwrite">("skip");
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  // 导入重指（T4）：previewModels 非 null 时表单换成重指表格；内容/格式变更
  // 视为预检结果作废（clearPreview），避免拿旧预检套用到新内容上
  const [previewing, setPreviewing] = useState(false);
  const [previewModels, setPreviewModels] = useState<PreviewModel[] | null>(null);
  const [previewWarnings, setPreviewWarnings] = useState<string[]>([]);
  const [remapChoices, setRemapChoices] = useState<Record<string, RemapChoice>>({});

  function clearPreview() {
    setPreviewModels(null);
    setPreviewWarnings([]);
    setRemapChoices({});
  }

  // bash 迁移：文件条目（name + content），提交时整体 POST
  const [fileName, setFileName] = useState("");
  const [fileContent, setFileContent] = useState("");
  const [files, setFiles] = useState<{ name: string; content: string }[]>([]);
  const [migrateStrategy, setMigrateStrategy] = useState<"skip" | "rename" | "overwrite">("skip");
  const [migrating, setMigrating] = useState(false);
  const [migrateResult, setMigrateResult] = useState<ImportResult | null>(null);
  const [migrateError, setMigrateError] = useState<string | null>(null);

  async function onExport() {
    if (exporting) return;
    setExporting(true);
    setExportResult(null);
    setExportError(null);
    const res = await apiFetch("/api/v1/export", { method: "POST" }).catch(() => null);
    setExporting(false);
    if (res === null) {
      setExportError(t("errorNetwork"));
      return;
    }
    if (!res.ok) {
      setExportError(t("errorRequest"));
      return;
    }
    const data = (await res.json()) as { path: string; bytes: number };
    setExportResult(t("ioExportDone", { path: data.path, size: formatSize(data.bytes) }));
  }

  async function onToggleSnapshot(next: boolean) {
    if (snapshotBusy) return;
    setSnapshotBusy(true);
    setSnapshotError(null);
    const res = await apiFetch("/api/v1/settings/auto_snapshot", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: next ? "1" : "0" }),
    }).catch(() => null);
    setSnapshotBusy(false);
    if (res === null) {
      setSnapshotError(t("errorNetwork"));
      return;
    }
    if (!res.ok) {
      setSnapshotError(t("errorRequest"));
      return;
    }
    setAutoSnapshot(next);
  }

  /** 实际提交导入：remapChoices 里有值的行才进 remap，其余按"跳过"落原路径 */
  async function submitImport() {
    setImporting(true);
    setImportResult(null);
    setImportError(null);
    const remapEntries = Object.entries(remapChoices).filter(
      ([, choice]) => choice.gguf_file !== undefined || choice.mmproj_file !== undefined,
    );
    const remap = remapEntries.length > 0 ? Object.fromEntries(remapEntries) : undefined;
    const res = await apiFetch("/api/v1/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: importContent, format: importFormat, strategy, remap }),
    }).catch(() => null);
    setImporting(false);
    if (res === null) {
      setImportError(t("errorNetwork"));
      return;
    }
    const data = (await res.json().catch(() => null)) as (ImportResult & { error?: string }) | null;
    if (!res.ok) {
      setImportError(data?.error ?? t("errorRequest"));
      return;
    }
    setImportResult(data);
    clearPreview();
  }

  /**
   * 导入按钮：首次点击先预检（T4，规格 §4）——全部命中直接提交，不打扰用户；
   * 有缺失则落地重指表格等待用户选择/跳过，点击「确认导入」再走 submitImport。
   */
  async function onImport() {
    if (importing || previewing || importContent.trim() === "") return;
    if (previewModels !== null) {
      await submitImport();
      return;
    }
    setPreviewing(true);
    setImportError(null);
    const res = await apiFetch("/api/v1/import/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: importContent, format: importFormat }),
    }).catch(() => null);
    setPreviewing(false);
    if (res === null) {
      setImportError(t("errorNetwork"));
      return;
    }
    const data = (await res.json().catch(() => null)) as
      | { models: PreviewModel[]; warnings: string[]; error?: string }
      | null;
    if (!res.ok) {
      setImportError(data?.error ?? t("errorRequest"));
      return;
    }
    const models = data?.models ?? [];
    if (models.every((m) => !m.ggufMissing && !m.mmprojMissing)) {
      await submitImport();
      return;
    }
    setPreviewModels(models);
    setPreviewWarnings(data?.warnings ?? []);
    setRemapChoices({});
  }

  function onAddFile() {
    const name = fileName.trim();
    if (name === "" || fileContent.trim() === "") return;
    setFiles((prev) => [...prev, { name, content: fileContent }]);
    setFileName("");
    setFileContent("");
  }

  async function onMigrate() {
    if (migrating || files.length === 0) return;
    setMigrating(true);
    setMigrateResult(null);
    setMigrateError(null);
    const res = await apiFetch("/api/v1/migrate/bash", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files, strategy: migrateStrategy }),
    }).catch(() => null);
    setMigrating(false);
    if (res === null) {
      setMigrateError(t("errorNetwork"));
      return;
    }
    const data = (await res.json().catch(() => null)) as (ImportResult & { error?: string }) | null;
    if (!res.ok) {
      setMigrateError(data?.error ?? t("errorRequest"));
      return;
    }
    setMigrateResult(data);
    setFiles([]);
  }

  /** 结果回显（导入/迁移共用） */
  function resultView(result: ImportResult) {
    const empty =
      result.imported.length === 0 &&
      result.skipped.length === 0 &&
      result.renamed.length === 0 &&
      result.warnings.length === 0 &&
      result.defaultsApplied !== true;
    if (empty) return <p className="text-xs text-muted-foreground">{t("ioResultEmpty")}</p>;
    return (
      <div className="flex flex-col gap-1 text-xs">
        {result.imported.length > 0 && (
          <p>
            <span className="font-medium">{t("ioResultImported")}：</span>
            <span className="font-mono">{result.imported.join("、")}</span>
          </p>
        )}
        {result.skipped.length > 0 && (
          <p className="text-muted-foreground">
            <span className="font-medium">{t("ioResultSkipped")}：</span>
            <span className="font-mono">{result.skipped.join("、")}</span>
          </p>
        )}
        {result.renamed.length > 0 && (
          <p>
            <span className="font-medium">{t("ioResultRenamed")}：</span>
            <span className="font-mono">
              {result.renamed.map((r) => `${r.from} → ${r.to}`).join("、")}
            </span>
          </p>
        )}
        {result.defaultsApplied === true && (
          <p className="text-muted-foreground">{t("ioResultDefaults")}</p>
        )}
        {result.warnings.length > 0 && (
          <ul className="list-disc pl-4 text-muted-foreground">
            {result.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2.5 border-b px-4 py-3">
        <PackagePlus className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">{t("ioTitle")}</h2>
        <span className="text-xs text-muted-foreground">{t("ioDescription")}</span>
      </div>

      <div className="flex flex-col gap-5 px-4 py-3.5">
        {/* 导出 + 自动快照开关 */}
        <div className="flex flex-wrap items-center gap-4">
          <Button size="sm" disabled={exporting} onClick={onExport}>
            {exporting ? <Loader2 className="size-3.5 animate-spin" /> : <FileDown className="size-3.5" />}
            {exporting ? t("ioExporting") : t("ioExportButton")}
          </Button>
          {exportResult && <p className="text-xs text-muted-foreground">{exportResult}</p>}
          {exportError && <p className="text-xs text-destructive">{exportError}</p>}
        </div>
        <div className="flex items-center gap-2.5">
          <Switch checked={autoSnapshot} onCheckedChange={(v) => onToggleSnapshot(Boolean(v))} disabled={snapshotBusy} />
          <div className="flex flex-col">
            <span className="text-sm">{t("ioSnapshotLabel")}</span>
            <span className="text-xs text-muted-foreground">{t("ioSnapshotHint")}</span>
          </div>
          {snapshotError && <p className="text-xs text-destructive">{snapshotError}</p>}
        </div>

        {/* 导入表单 */}
        <div className="flex flex-col gap-2 border-t pt-4">
          <h3 className="text-sm font-semibold">{t("ioImportTitle")}</h3>
          <p className="text-xs text-muted-foreground">{t("ioImportHint")}</p>
          <Textarea
            className="min-h-32 font-mono text-xs"
            placeholder={t("ioImportPlaceholder")}
            value={importContent}
            onChange={(e) => {
              setImportContent(e.target.value);
              clearPreview();
            }}
            spellCheck={false}
            disabled={previewModels !== null}
          />
          {previewModels === null ? (
            <>
              <div className="flex flex-wrap items-end gap-3">
                <div className="flex flex-col gap-1">
                  <Label className="text-xs text-muted-foreground">{t("ioImportFormat")}</Label>
                  <Select
                    value={importFormat}
                    onValueChange={(v) => {
                      setImportFormat(v as "llamapad" | "bash");
                      clearPreview();
                    }}
                  >
                    <SelectTrigger size="sm" className="w-44">
                      <SelectValue>{importFormat === "llamapad" ? t("ioFormatLlamapad") : t("ioFormatBash")}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="llamapad">{t("ioFormatLlamapad")}</SelectItem>
                      <SelectItem value="bash">{t("ioFormatBash")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1">
                  <Label className="text-xs text-muted-foreground">{t("ioImportStrategy")}</Label>
                  <Select value={strategy} onValueChange={(v) => setStrategy(v as "skip" | "rename" | "overwrite")}>
                    <SelectTrigger size="sm" className="w-44">
                      <SelectValue>
                        {strategy === "skip" ? t("ioStrategySkip") : strategy === "rename" ? t("ioStrategyRename") : t("ioStrategyOverwrite")}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="skip">{t("ioStrategySkip")}</SelectItem>
                      <SelectItem value="rename">{t("ioStrategyRename")}</SelectItem>
                      <SelectItem value="overwrite">{t("ioStrategyOverwrite")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Button size="sm" disabled={importing || previewing || importContent.trim() === ""} onClick={onImport}>
                  {importing || previewing ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
                  {previewing ? t("ioPreviewing") : importing ? t("ioImporting") : t("ioImportButton")}
                </Button>
              </div>
              {importError && <p className="text-xs text-destructive">{importError}</p>}
            </>
          ) : (
            <div className="flex flex-col gap-3 rounded-md border p-3">
              <p className="text-xs text-muted-foreground">{t("ioRemapHint")}</p>
              {previewWarnings.length > 0 && (
                <ul className="list-disc pl-4 text-xs text-muted-foreground">
                  {previewWarnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              )}
              <ul className="flex flex-col gap-2">
                {previewModels
                  .filter((m) => m.ggufMissing || m.mmprojMissing)
                  .map((m) => (
                    <RemapRow
                      key={m.name}
                      model={m}
                      choice={remapChoices[m.name]}
                      pickerItems={pickerItems}
                      onPick={(field, value) =>
                        setRemapChoices((prev) => ({ ...prev, [m.name]: { ...prev[m.name], [field]: value } }))
                      }
                      onUndo={(field) =>
                        setRemapChoices((prev) => {
                          const current = prev[m.name];
                          if (!current) return prev;
                          const next = { ...current };
                          delete next[field];
                          return { ...prev, [m.name]: next };
                        })
                      }
                    />
                  ))}
              </ul>
              <div className="flex flex-wrap items-center gap-3">
                <Button size="sm" disabled={importing} onClick={onImport}>
                  {importing ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
                  {importing ? t("ioImporting") : t("ioRemapConfirm")}
                </Button>
                <Button size="sm" variant="outline" disabled={importing} onClick={clearPreview}>
                  {t("ioRemapCancel")}
                </Button>
              </div>
              {importError && <p className="text-xs text-destructive">{importError}</p>}
            </div>
          )}
          {importResult && resultView(importResult)}
        </div>

        {/* bash 迁移 */}
        <div className="flex flex-col gap-2 border-t pt-4">
          <h3 className="text-sm font-semibold">{t("ioMigrateTitle")}</h3>
          <p className="text-xs text-muted-foreground">{t("ioMigrateDescription")}</p>
          <div className="flex flex-col gap-2">
            {files.length > 0 && (
              <ul className="flex flex-wrap gap-1.5">
                {files.map((f, i) => (
                  <li key={`${f.name}-${i}`} className="flex items-center gap-1 rounded-md bg-muted px-2 py-1 font-mono text-xs">
                    {f.name}
                    <button
                      type="button"
                      className="text-muted-foreground transition-colors hover:text-destructive"
                      onClick={() => setFiles((prev) => prev.filter((_, idx) => idx !== i))}
                      aria-label={t("ioMigrateRemove")}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex items-center gap-2">
              <Input
                className="max-w-64 font-mono"
                placeholder={t("ioMigrateFileName")}
                value={fileName}
                onChange={(e) => setFileName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onAddFile();
                }}
              />
              <Button variant="outline" size="sm" disabled={fileName.trim() === "" || fileContent.trim() === ""} onClick={onAddFile}>
                {t("ioMigrateAddButton")}
              </Button>
            </div>
            <Textarea
              className="min-h-24 font-mono text-xs"
              placeholder={t("ioImportPlaceholder")}
              value={fileContent}
              onChange={(e) => setFileContent(e.target.value)}
              spellCheck={false}
            />
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <Label className="text-xs text-muted-foreground">{t("ioImportStrategy")}</Label>
              <Select value={migrateStrategy} onValueChange={(v) => setMigrateStrategy(v as "skip" | "rename" | "overwrite")}>
                <SelectTrigger size="sm" className="w-44">
                  <SelectValue>
                    {migrateStrategy === "skip" ? t("ioStrategySkip") : migrateStrategy === "rename" ? t("ioStrategyRename") : t("ioStrategyOverwrite")}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="skip">{t("ioStrategySkip")}</SelectItem>
                  <SelectItem value="rename">{t("ioStrategyRename")}</SelectItem>
                  <SelectItem value="overwrite">{t("ioStrategyOverwrite")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button size="sm" disabled={migrating || files.length === 0} onClick={onMigrate}>
              {migrating && <Loader2 className="size-3.5 animate-spin" />}
              {migrating ? t("ioMigrating") : t("ioMigrateButton")}
            </Button>
          </div>
          {migrateError && <p className="text-xs text-destructive">{migrateError}</p>}
          {migrateResult && resultView(migrateResult)}
        </div>
      </div>
    </Card>
  );
}

/** 重指表格一行（T4）：一个缺失模型，按缺失字段各展示一个 RemapField */
function RemapRow({
  model,
  choice,
  pickerItems,
  onPick,
  onUndo,
}: {
  model: PreviewModel;
  choice: RemapChoice | undefined;
  pickerItems: PickerItem[];
  onPick: (field: "gguf_file" | "mmproj_file", value: string) => void;
  onUndo: (field: "gguf_file" | "mmproj_file") => void;
}) {
  const t = useTranslations("pages.settings");
  return (
    <li className="flex flex-col gap-2 rounded-md border p-2.5">
      <p className="truncate font-mono text-sm font-medium">{model.name}</p>
      {model.ggufMissing && (
        <RemapField
          label={t("ioRemapGgufMissing")}
          original={model.gguf_file}
          picked={choice?.gguf_file}
          pickerField="gguf"
          pickerItems={pickerItems}
          onPick={(v) => onPick("gguf_file", v)}
          onUndo={() => onUndo("gguf_file")}
        />
      )}
      {model.mmprojMissing && model.mmproj_file !== null && (
        <RemapField
          label={t("ioRemapMmprojMissing")}
          original={model.mmproj_file}
          picked={choice?.mmproj_file}
          pickerField="mmproj"
          pickerItems={pickerItems}
          onPick={(v) => onPick("mmproj_file", v)}
          onUndo={() => onUndo("mmproj_file")}
        />
      )}
    </li>
  );
}

/** 重指表格一个字段：缺失徽标 + 当前路径（跳过时为原路径，选过为新路径）+ 选择器 + 撤销 */
function RemapField({
  label,
  original,
  picked,
  pickerField,
  pickerItems,
  onPick,
  onUndo,
}: {
  label: string;
  original: string;
  picked: string | undefined;
  pickerField: "gguf" | "mmproj";
  pickerItems: PickerItem[];
  onPick: (value: string) => void;
  onUndo: () => void;
}) {
  const t = useTranslations("pages.settings");
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <Badge
        variant="outline"
        className="shrink-0 border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
      >
        {label}
      </Badge>
      <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">{picked ?? original}</span>
      <ModelFilePicker items={pickerItems} field={pickerField} onSelect={onPick} />
      {picked !== undefined && (
        <Button type="button" variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={onUndo}>
          {t("ioRemapUndo")}
        </Button>
      )}
    </div>
  );
}
