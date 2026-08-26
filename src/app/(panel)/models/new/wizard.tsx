"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { ArrowLeft, ArrowRight, Check, Link2, Loader2, Search, TriangleAlert } from "lucide-react";

import { shardGroup } from "@/core/files";
import { cacheTypeSchema, type DefaultConfig, type Overrides } from "@/core/schemas";
import { formatSize } from "@/lib/format";
import { cn } from "@/lib/utils";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { apiFetch } from "@/lib/api";

/**
 * 新建模型向导（M2 Task 7，client 四步）：
 * 1 名称·空间 → 2 来源（HF 仓库 / URL 直链 Tab）→ 3 文件（量化分组 RadioCard
 * 选择 + mmproj 独立勾选 + 磁盘预检）→ 4 参数（overrides 精简表单 + 摘要）。
 *
 * 步骤条语义对照 ui-demo/wizard.html：done=绿勾可回退、cur=amber 高亮、todo=灰。
 * 仅在当前步校验通过后才能前进（HF 模式的前进动作是「浏览文件」成功本身）。
 *
 * 提交语义（两组请求）：
 * - POST /api/v1/models：分片组 gguf_file 存 glob 形态（首片前缀 + "-*.gguf"，
 *   保留量化段防跨量化误并，与 M1 resolveModelFiles 的展开语义一致）；单文件存
 *   精确名。download.file 同 glob/文件名（单文件重试语义）。
 * - POST /api/v1/models/:name/download：files = 组内全部文件 {file,size,sha256}，
 *   sha256 取 HF LFS oid（内容哈希；非 LFS 文件无 oid 则省略）。
 * 模型创建成功后标记 createdRef，下载入队失败重试时跳过重复创建。
 */

/** 与 GET /api/v1/hf/repos/:id/files 响应一致（客户端不 import server 模块） */
interface WizardRepoFile {
  path: string;
  size: number;
  oid?: string;
}

interface WizardGroup {
  quant: string | null;
  label: string;
  kind: "model" | "mmproj";
  files: WizardRepoFile[];
  totalSize: number;
  shards: number;
  shardTotalDeclared: number | null;
}

interface FilesResponse {
  groups: WizardGroup[];
  hasGguf: boolean;
  total: number;
}

/** 与 GET /api/v1/namespaces 行结构一致 */
interface NamespaceEntry {
  name: string;
  createdAt: string;
  modelCount: number;
  bytes: number;
}

/** 与 GET /api/v1/disk 响应结构一致 */
interface DiskInfo {
  totalBytes: number | null;
  usedBytes: number;
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
/** 命名空间 Select 的「＋新建空间」哨兵（与 edit-form 的 DEFAULT_OPTION 同惯例） */
const NEW_NAMESPACE_OPTION = "__new__";

function toIntOrNull(s: string): number | null {
  const t = s.trim();
  if (t === "" || !/^-?\d+$/.test(t)) return null;
  return Number(t);
}

function toFloatOrNull(s: string): number | null {
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** URL 末段（去 query、decode）；解析失败返回空串 */
function lastSegmentOfUrl(u: string): string {
  try {
    const seg = new URL(u).pathname.split("/").filter(Boolean).pop() ?? "";
    return decodeURIComponent(seg);
  } catch {
    return "";
  }
}

/**
 * 组 → 配置路径：分片命名（shardGroup 命中）存 glob = 首片前缀 + "-*.gguf"
 * （例：Qwen3-8B-Q4_K_M-00001-of-00003.gguf → Qwen3-8B-Q4_K_M-*.gguf）；单文件存精确路径。
 * 前缀含子目录时 glob 同样带目录（与 quant.ts 的 shardKey 语义一致）。
 */
function globForGroup(files: WizardRepoFile[]): string {
  const first = files[0]!.path;
  const group = shardGroup(first);
  return group === null ? first : `${group.prefix}-*.gguf`;
}

/** HF LFS oid（内容 sha256）转下载文件条目；非 LFS（无 oid）省略校验字段 */
function toDownloadFile(f: WizardRepoFile): { file: string; size: number; sha256?: string } {
  return {
    file: f.path,
    size: f.size,
    ...(f.oid !== undefined && SHA256_PATTERN.test(f.oid) ? { sha256: f.oid } : {}),
  };
}

// ---------- 小组件 ----------

/** 步骤条：done=绿勾可点回退，cur=amber，todo=灰不可点（对照 ui-demo/wizard.html） */
function StepBar({ step, onJump }: { step: number; onJump: (n: number) => void }) {
  const t = useTranslations("pages.modelsNew");
  const labels = [t("step1"), t("step2"), t("step3"), t("step4")];
  return (
    <nav aria-label={t("stepsLabel")} className="flex flex-wrap items-center gap-2.5 text-xs">
      {labels.map((label, i) => {
        const n = i + 1;
        const done = n < step;
        const cur = n === step;
        const circle = cn(
          "flex size-5.5 shrink-0 items-center justify-center rounded-full border font-mono text-[11px]",
          done && "border-accent-green/50 text-accent-green",
          cur && "border-amber-500 text-amber-600 dark:text-amber-400",
          !done && !cur && "border-border text-muted-foreground/70",
        );
        const body = (
          <>
            <span className={circle}>
              {done ? <Check className="size-3" /> : n}
            </span>
            <span
              className={cn(
                cur && "font-semibold text-foreground",
                !cur && "text-muted-foreground",
              )}
            >
              {label}
            </span>
          </>
        );
        return (
          <span key={n} className="flex items-center gap-2.5">
            {i > 0 && <span aria-hidden className="h-px w-7 bg-border" />}
            {done ? (
              <button
                type="button"
                onClick={() => onJump(n)}
                className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 transition-colors hover:bg-muted"
              >
                {body}
              </button>
            ) : (
              <span className="flex items-center gap-2">{body}</span>
            )}
          </span>
        );
      })}
    </nav>
  );
}

/** 表单字段外壳（与 edit-form 的 FieldShell 同语义） */
function FieldShell({
  label,
  param,
  hint,
  error,
  children,
}: {
  label: string;
  param?: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label className="items-baseline">
        <span>{label}</span>
        {param && (
          <code className="font-mono text-[11px] font-normal text-muted-foreground">{param}</code>
        )}
      </Label>
      {children}
      {hint && <p className="text-xs leading-snug text-muted-foreground">{hint}</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

/** 数字输入（草稿字符串，空 = 不覆盖，placeholder 显示默认值） */
function NumInput({
  value,
  onChange,
  placeholder,
  step,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  step?: string;
}) {
  return (
    <Input
      type="number"
      step={step}
      className="font-mono"
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/** 量化分组 RadioCard（对照 demo 的 .radio-card / .radio-card.sel） */
function GroupCard({
  selected,
  onClick,
  label,
  meta,
  warning,
  size,
  badge,
}: {
  selected: boolean;
  onClick: () => void;
  label: string;
  meta: string;
  warning?: string;
  size: string;
  badge?: ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onClick}
      className={cn(
        "flex w-full cursor-pointer items-center gap-3.5 rounded-xl border px-4 py-3.5 text-left transition-colors",
        selected
          ? "border-primary bg-primary/5"
          : "border-border hover:border-foreground/25 hover:bg-muted/40",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "flex size-4.5 shrink-0 items-center justify-center rounded-full border",
          selected ? "border-primary" : "border-muted-foreground/40",
        )}
      >
        {selected && <span className="size-2 rounded-full bg-primary" />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2 font-mono text-sm font-semibold">
          {label}
          {badge}
        </span>
        <span className="truncate font-mono text-xs text-muted-foreground" title={meta}>
          {meta}
        </span>
        {warning && (
          <span className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
            <TriangleAlert className="size-3 shrink-0" />
            {warning}
          </span>
        )}
      </span>
      <span className="shrink-0 font-mono text-[13px] tabular-nums">{size}</span>
    </button>
  );
}

// ---------- 主组件 ----------

export function ModelWizard({
  initialNamespaces,
  initialDisk,
  defaults,
}: {
  initialNamespaces: NamespaceEntry[];
  initialDisk: DiskInfo;
  defaults: DefaultConfig;
}) {
  const t = useTranslations("pages.modelsNew");
  const router = useRouter();

  const [step, setStep] = useState(1);
  /** 提交期错误横幅（模型创建 / 下载入队两阶段共用，文案带阶段前缀） */
  const [submitError, setSubmitError] = useState<string | null>(null);

  // ---- Step 1：名称 · 空间 ----
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [namespaces, setNamespaces] = useState(initialNamespaces);
  const [namespace, setNamespace] = useState(
    initialNamespaces[0]?.name ?? "main",
  );
  const [newNamespace, setNewNamespace] = useState("");
  const [nsBusy, setNsBusy] = useState(false);
  const [nsError, setNsError] = useState<string | null>(null);
  /** 已存在的模型名（查重用，挂载时拉一次；单管理员面板无并发创建窗口） */
  const [takenNames, setTakenNames] = useState<Set<string>>(new Set());

  useEffect(() => {
    apiFetch("/api/v1/models", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { models: { name: string }[] } | null) => {
        if (d) setTakenNames(new Set(d.models.map((m) => m.name)));
      })
      .catch(() => {
        // 查重拉取失败不阻塞表单：服务端 POST /models 的重名守卫兜底
      });
  }, []);

  const nameValid = NAME_PATTERN.test(name);
  const nameTaken = nameValid && takenNames.has(name);
  const nameError =
    name === "" ? undefined : nameTaken ? t("nameTaken") : nameValid ? undefined : t("nameInvalid");
  /** 当前生效空间：新建模式（哨兵）下未创建完成视为未选定 */
  const namespaceValue = namespace === NEW_NAMESPACE_OPTION ? null : namespace;

  async function createNamespace(): Promise<void> {
    const nm = newNamespace.trim();
    if (nm === "" || nsBusy) return;
    setNsBusy(true);
    setNsError(null);
    const res = await apiFetch("/api/v1/namespaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: nm }),
    }).catch(() => null);
    setNsBusy(false);
    if (res === null) {
      setNsError(t("errorNetwork"));
      return;
    }
    if (res.ok) {
      // 拉回列表并选中新空间（Select 回到列表态，隐藏新建输入框）
      const list = await apiFetch("/api/v1/namespaces", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      if (list) setNamespaces(list.namespaces as NamespaceEntry[]);
      setNewNamespace("");
      setNamespace(nm);
      return;
    }
    if (res.status === 409) setNsError(t("namespaceDuplicate"));
    else if (res.status === 400) setNsError(t("namespaceInvalid"));
    else setNsError(t("errorNamespaceRequest"));
  }

  const step1Valid = nameValid && !nameTaken && namespaceValue !== null;

  // ---- Step 2：来源 ----
  const [sourceTab, setSourceTab] = useState<"hf" | "url">("hf");
  const [repo, setRepo] = useState("");
  const [browsing, setBrowsing] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [repoFiles, setRepoFiles] = useState<FilesResponse | null>(null);
  const [url, setUrl] = useState("");
  const [urlFile, setUrlFile] = useState("");
  const [urlFileTouched, setUrlFileTouched] = useState(false);
  const [urlSha, setUrlSha] = useState("");

  const urlParsed = (() => {
    try {
      const u = new URL(url.trim());
      return u.protocol === "http:" || u.protocol === "https:" ? u : null;
    } catch {
      return null;
    }
  })();
  const urlFileValid = /^[^/\s:]+\.gguf$/.test(urlFile.trim());
  const shaValid = urlSha.trim() === "" || SHA256_PATTERN.test(urlSha.trim());
  const step2UrlValid = url.trim() !== "" && urlParsed !== null && urlFileValid && shaValid;

  async function browseFiles(): Promise<void> {
    const id = repo.trim();
    if (id === "" || browsing) return;
    setBrowsing(true);
    setBrowseError(null);
    const res = await apiFetch(`/api/v1/hf/repos/${encodeURIComponent(id)}/files`, {
      cache: "no-store",
    }).catch(() => null);
    setBrowsing(false);
    if (res === null) {
      setBrowseError(t("errorNetwork"));
      return;
    }
    if (!res.ok) {
      // files API 失败统一 502 + 已映射中文 message（404/401/429/网络文案直接展示）
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      setBrowseError(body?.error ?? t("errorFiles"));
      return;
    }
    const data = (await res.json()) as FilesResponse;
    setRepoFiles(data);
    setSelectedGroup(-1); // 新仓库重新选择
    setMmprojGroup(-1);
    setStep(3);
  }

  // ---- Step 3：文件 ----
  const [selectedGroup, setSelectedGroup] = useState(-1);
  const [mmprojGroup, setMmprojGroup] = useState(-1);
  const [disk, setDisk] = useState<DiskInfo>(initialDisk);

  // 进入第 3 步时刷新磁盘剩余（初始值来自 server 装配，此处取更新鲜的）
  useEffect(() => {
    if (step !== 3) return;
    apiFetch("/api/v1/disk", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: DiskInfo | null) => {
        if (d) setDisk(d);
      })
      .catch(() => {});
  }, [step]);

  const modelGroups = repoFiles?.groups.filter((g) => g.kind === "model") ?? [];
  const mmprojGroups = repoFiles?.groups.filter((g) => g.kind === "mmproj") ?? [];
  const selected = selectedGroup >= 0 ? modelGroups[selectedGroup] : undefined;
  const mmproj = mmprojGroup >= 0 ? mmprojGroups[mmprojGroup] : undefined;
  const totalSelected = (selected?.totalSize ?? 0) + (mmproj?.totalSize ?? 0);
  const diskFree = disk.totalBytes !== null ? Math.max(0, disk.totalBytes - disk.usedBytes) : null;
  const diskShort = diskFree !== null && totalSelected > diskFree;
  const step3Valid = sourceTab === "url" ? step2UrlValid : selectedGroup >= 0 && !diskShort;

  // ---- Step 4：参数 ----
  const [gpuLayers, setGpuLayers] = useState("");
  const [ctxSize, setCtxSize] = useState("");
  const [cacheK, setCacheK] = useState("");
  const [temp, setTemp] = useState("");
  const [submitting, setSubmitting] = useState(false);
  /** U15 下载完成后自动启动（默认开——闭环顺手；届时已有模型在跑会跳过而非切换） */
  const [autoStart, setAutoStart] = useState(true);
  /** 模型已创建标记：下载入队失败重试时跳过重复 POST /models */
  const createdRef = useRef(false);

  interface SubmitPlan {
    model: {
      name: string;
      display_name: string;
      namespace: string;
      gguf_file: string;
      mmproj_file?: string;
      download:
        | { source: "hf"; repo: string; file: string }
        | { source: "url"; url: string; file: string; sha256?: string };
      overrides: Overrides;
    };
    files: { file: string; size?: number; sha256?: string }[];
  }

  /** 由当前选择推导提交 payload（摘要卡与提交共用，保证所见即所存） */
  function derivePlan(): SubmitPlan {
    const ns = namespaceValue ?? "main";
    const overrides: Overrides = {};
    const server: Record<string, string | number> = {};
    const gl = toIntOrNull(gpuLayers);
    if (gl !== null) server.gpu_layers = gl;
    const cs = toIntOrNull(ctxSize);
    if (cs !== null) server.ctx_size = cs;
    if (cacheK) server.cache_type_k = cacheK;
    const tp = toFloatOrNull(temp);
    if (tp !== null) server.temp = tp;
    if (Object.keys(server).length > 0) overrides.server = server as Overrides["server"];

    if (sourceTab === "hf" && repoFiles !== undefined && selected !== undefined) {
      const glob = globForGroup(selected.files);
      const files = selected.files.map(toDownloadFile);
      let mmprojFile: string | undefined;
      if (mmproj !== undefined) {
        mmprojFile = `${ns}/${globForGroup(mmproj.files)}`;
        files.push(...mmproj.files.map(toDownloadFile));
      }
      return {
        model: {
          name,
          display_name: displayName.trim() || name,
          namespace: ns,
          gguf_file: `${ns}/${glob}`,
          ...(mmprojFile !== undefined ? { mmproj_file: mmprojFile } : {}),
          download: { source: "hf", repo: repo.trim(), file: glob },
          overrides,
        },
        files,
      };
    }

    const file = urlFile.trim();
    const sha = urlSha.trim();
    return {
      model: {
        name,
        display_name: displayName.trim() || name,
        namespace: ns,
        gguf_file: `${ns}/${file}`,
        download: {
          source: "url",
          url: url.trim(),
          file,
          ...(sha !== "" ? { sha256: sha } : {}),
        },
        overrides,
      },
      files: [{ file, ...(sha !== "" ? { sha256: sha } : {}) }],
    };
  }

  async function onSubmit(): Promise<void> {
    if (submitting || !step1Valid || !step3Valid) return;
    setSubmitting(true);
    setSubmitError(null);
    const plan = derivePlan();
    function fail(message: string): void {
      setSubmitError(message);
      setSubmitting(false);
    }

    if (!createdRef.current) {
      const res = await apiFetch("/api/v1/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(plan.model),
      }).catch(() => null);
      if (res === null) {
        fail(t("errorNetwork"));
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          issues?: { path: string; message: string }[];
          error?: string;
        } | null;
        const issues = body?.issues;
        fail(
          issues && issues.length > 0
            ? `${t("errorCreate")}: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`
            : `${t("errorCreate")}: ${body?.error ?? t("errorRequest")}`,
        );
        return;
      }
      createdRef.current = true;
    }

    const dl = await apiFetch(`/api/v1/models/${encodeURIComponent(plan.model.name)}/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files: plan.files, autoStart }),
    }).catch(() => null);
    if (dl === null) {
      fail(t("errorNetwork"));
      return;
    }
    if (dl.status === 202) {
      router.push("/downloads");
      return;
    }
    const body = (await dl.json().catch(() => null)) as { error?: string } | null;
    fail(`${t("errorDownload")}: ${body?.error ?? t("errorRequest")}`);
  }

  function goStep(next: number): void {
    setStep(next);
    setSubmitError(null);
  }

  // ---- 各步渲染 ----

  const step1Form = (
    <Card>
      <CardContent className="flex flex-col gap-3.5">
        <h2 className="text-sm font-semibold">{t("step1")}</h2>
        <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
          <FieldShell label={t("labelName")} error={nameError} hint={t("nameHint")}>
            <Input
              className="font-mono"
              placeholder="qwen3-8b"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={nameError !== undefined || undefined}
            />
          </FieldShell>
          <FieldShell label={t("labelDisplayName")} hint={t("displayNameHint")}>
            <Input
              placeholder={name || t("displayNamePlaceholder")}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </FieldShell>
        </div>
        <FieldShell label={t("labelNamespace")} hint={t("namespaceHint")}>
          <Select value={namespace} onValueChange={(v) => setNamespace(String(v))}>
            <SelectTrigger className="w-full">
              <SelectValue>
                {(v: string | null) =>
                  v === NEW_NAMESPACE_OPTION ? t("createNamespaceOption") : String(v ?? "")
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {namespaces.map((ns) => (
                <SelectItem key={ns.name} value={ns.name}>
                  <span className="flex w-full items-center gap-3">
                    <span className="font-mono">{ns.name}</span>
                    <span className="ml-auto text-xs text-muted-foreground">
                      {t("namespaceBytes", { size: formatSize(ns.bytes) })}
                    </span>
                  </span>
                </SelectItem>
              ))}
              <SelectItem value={NEW_NAMESPACE_OPTION}>{t("createNamespaceOption")}</SelectItem>
            </SelectContent>
          </Select>
          {namespace === NEW_NAMESPACE_OPTION && (
            <div className="mt-1.5 flex gap-2">
              <Input
                className="font-mono"
                placeholder={t("newNamespacePlaceholder")}
                value={newNamespace}
                onChange={(e) => setNewNamespace(e.target.value)}
                aria-invalid={nsError !== null || undefined}
              />
              <Button
                type="button"
                variant="outline"
                disabled={newNamespace.trim() === "" || nsBusy}
                onClick={() => void createNamespace()}
              >
                {nsBusy && <Loader2 className="animate-spin" />}
                {nsBusy ? t("creatingNamespace") : t("createNamespace")}
              </Button>
            </div>
          )}
          {nsError && <p className="text-xs text-destructive">{nsError}</p>}
        </FieldShell>
      </CardContent>
    </Card>
  );

  const step2Form = (
    <Card>
      <CardContent className="flex flex-col gap-3.5">
        <h2 className="text-sm font-semibold">{t("step2")}</h2>
        <Tabs value={sourceTab} onValueChange={(v) => setSourceTab(v === "url" ? "url" : "hf")}>
          <TabsList>
            <TabsTrigger value="hf">{t("sourceTabHf")}</TabsTrigger>
            <TabsTrigger value="url">{t("sourceTabUrl")}</TabsTrigger>
          </TabsList>

          <TabsContent value="hf" className="mt-3.5">
            <form
              className="flex flex-col gap-3.5"
              onSubmit={(e) => {
                e.preventDefault();
                void browseFiles();
              }}
            >
              <FieldShell label={t("labelRepo")} hint={t("repoHint")}>
                <div className="flex gap-2">
                  <Input
                    className="font-mono"
                    placeholder="bartowski/Qwen3-32B-GGUF"
                    value={repo}
                    onChange={(e) => setRepo(e.target.value)}
                    aria-invalid={browseError !== null || undefined}
                  />
                  <Button type="submit" disabled={repo.trim() === "" || browsing}>
                    {browsing ? <Loader2 className="animate-spin" /> : <Search className="size-3.5" />}
                    {browsing ? t("browsing") : t("actionBrowse")}
                  </Button>
                </div>
              </FieldShell>
              {browseError && (
                <p
                  role="alert"
                  className="break-all rounded-lg bg-destructive/10 px-2.5 py-2 text-xs text-destructive"
                >
                  {browseError}
                </p>
              )}
            </form>
          </TabsContent>

          <TabsContent value="url" className="mt-3.5">
            <div className="flex flex-col gap-3.5">
              <FieldShell label={t("labelUrl")} error={url.trim() !== "" && urlParsed === null ? t("urlInvalid") : undefined}>
                <Input
                  className="font-mono"
                  placeholder="https://example.com/Qwen3-8B-Q4_K_M.gguf"
                  value={url}
                  onChange={(e) => {
                    setUrl(e.target.value);
                    // 未手动改过文件名时跟随 URL 末段（默认取 URL 末段）
                    if (!urlFileTouched) setUrlFile(lastSegmentOfUrl(e.target.value));
                  }}
                  aria-invalid={(url.trim() !== "" && urlParsed === null) || undefined}
                />
              </FieldShell>
              <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
                <FieldShell
                  label={t("labelUrlFile")}
                  error={urlFile.trim() !== "" && !urlFileValid ? t("urlFileInvalid") : undefined}
                  hint={t("urlFileHint")}
                >
                  <Input
                    className="font-mono"
                    placeholder="Qwen3-8B-Q4_K_M.gguf"
                    value={urlFile}
                    onChange={(e) => {
                      setUrlFileTouched(true);
                      setUrlFile(e.target.value);
                    }}
                    aria-invalid={(urlFile.trim() !== "" && !urlFileValid) || undefined}
                  />
                </FieldShell>
                <FieldShell
                  label={t("labelSha")}
                  error={shaValid ? undefined : t("shaInvalid")}
                  hint={t("shaHint")}
                >
                  <Input
                    className="font-mono"
                    placeholder="—"
                    value={urlSha}
                    onChange={(e) => setUrlSha(e.target.value)}
                    aria-invalid={!shaValid || undefined}
                  />
                </FieldShell>
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );

  /** Step 3 主体：HF=分组选择；URL=单文件预览；hasGguf=false=整页提示 */
  const step3Body = (() => {
    if (sourceTab === "url") {
      return (
        <Card>
          <CardContent className="flex items-center gap-3.5">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <Link2 className="size-4.5" />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate font-mono text-sm font-semibold">{urlFile.trim()}</span>
              <span className="text-xs text-muted-foreground">{t("urlSizeUnknown")}</span>
              {urlSha.trim() !== "" && (
                <span className="truncate font-mono text-xs text-muted-foreground" title={urlSha}>
                  sha256: {urlSha.trim()}
                </span>
              )}
            </div>
            <Badge variant="outline" className="font-mono text-xs text-muted-foreground">
              {t("sourceTabUrl")}
            </Badge>
          </CardContent>
        </Card>
      );
    }

    if (repoFiles === null) {
      return null; // 正常到不了：HF 模式只有浏览成功才会进入第 3 步
    }

    if (!repoFiles.hasGguf) {
      return (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-3 py-14 text-center">
            <span className="flex size-12 items-center justify-center rounded-xl bg-amber-500/10 text-amber-600 dark:text-amber-400">
              <TriangleAlert className="size-6" />
            </span>
            <p className="text-sm font-medium">{t("noGgufTitle")}</p>
            <p className="max-w-md text-sm text-muted-foreground">{t("noGgufHint")}</p>
            <Button variant="outline" size="sm" className="mt-1" onClick={() => goStep(2)}>
              <ArrowLeft className="size-3.5" />
              {t("backToSource")}
            </Button>
          </CardContent>
        </Card>
      );
    }

    const ggufCount = repoFiles.groups.reduce((sum, g) => sum + g.files.length, 0);
    return (
      <div className="flex flex-col gap-3.5">
        <Card>
          <CardContent className="flex items-center gap-3">
            <Search className="size-4.5 shrink-0 text-muted-foreground" />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate font-mono text-[13px] font-medium">{repo.trim()}</span>
              <span className="text-xs text-muted-foreground">
                {t("repoSummary", {
                  files: ggufCount,
                  groups: modelGroups.length,
                  total: repoFiles.total,
                })}
              </span>
            </div>
          </CardContent>
        </Card>

        <div role="radiogroup" aria-label={t("selectGroupLabel")} className="flex flex-col gap-2.5">
          {modelGroups.map((group, i) => (
            <GroupCard
              key={`${group.label}-${i}`}
              selected={selectedGroup === i}
              onClick={() => setSelectedGroup(i)}
              label={group.label}
              meta={`${group.shards > 1 ? t("groupShards", { count: group.shards }) : t("groupSingle")} · ${group.files[0]!.path}`}
              warning={
                group.shardTotalDeclared !== null && group.shardTotalDeclared !== group.files.length
                  ? t("missingShards", { declared: group.shardTotalDeclared, found: group.files.length })
                  : undefined
              }
              size={formatSize(group.totalSize)}
            />
          ))}
        </div>

        {mmprojGroups.length > 0 && (
          <div className="flex flex-col gap-2.5">
            <p className="text-xs font-medium text-muted-foreground">{t("mmprojTitle")}</p>
            {mmprojGroups.map((group, i) => (
              <GroupCard
                key={`mmproj-${group.label}-${i}`}
                selected={mmprojGroup === i}
                onClick={() => setMmprojGroup(mmprojGroup === i ? -1 : i)} // 独立勾选，可取消
                label={group.files[0]!.path}
                meta={t("mmprojHint")}
                size={formatSize(group.totalSize)}
                badge={
                  <Badge variant="outline" className="font-mono text-xs text-muted-foreground">
                    mmproj
                  </Badge>
                }
              />
            ))}
          </div>
        )}
      </div>
    );
  })();

  /** Step 4：摘要 + 精简参数表单（提交计划实时推导，与提交共用 derivePlan） */
  const step4Body = (() => {
    const plan = derivePlan();
    const source =
      plan.model.download.source === "hf"
        ? t("summarySourceHf", { repo: plan.model.download.repo })
        : t("sourceTabUrl");
    return (
      <div className="flex flex-col gap-3.5">
        <Card>
          <CardContent className="flex flex-col gap-2.5">
            <h2 className="text-sm font-semibold">{t("summaryTitle")}</h2>
            <dl className="flex flex-col gap-1.5 text-sm">
              {[
                [t("summaryName"), plan.model.name],
                [t("summaryDisplayName"), plan.model.display_name],
                [t("summaryNamespace"), plan.model.namespace],
                [t("summarySource"), source],
                [t("summaryGgufFile"), plan.model.gguf_file],
                ...(plan.model.mmproj_file !== undefined
                  ? [[t("summaryMmprojFile"), plan.model.mmproj_file] as const]
                  : []),
              ].map(([k, v]) => (
                <div key={k} className="flex items-baseline justify-between gap-4">
                  <dt className="shrink-0 text-xs text-muted-foreground">{k}</dt>
                  <dd className="min-w-0 break-all text-right font-mono text-[13px]">{v}</dd>
                </div>
              ))}
            </dl>
            <div className="border-t pt-2">
              <p className="mb-1.5 text-xs text-muted-foreground">{t("summaryFiles")}</p>
              <div className="flex flex-col gap-1 font-mono text-xs">
                {plan.files.map((f) => (
                  <div key={f.file} className="flex items-baseline justify-between gap-4">
                    <span className="min-w-0 break-all">{f.file}</span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {f.size !== undefined ? formatSize(f.size) : t("urlSizeUnknown")}
                    </span>
                  </div>
                ))}
                <div className="flex items-baseline justify-between gap-4 border-t pt-1 font-medium">
                  <span>{t("summaryTotal")}</span>
                  <span className="tabular-nums">
                    {formatSize(plan.files.reduce((sum, f) => sum + (f.size ?? 0), 0))}
                  </span>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex flex-col gap-3.5">
            <div className="flex flex-col gap-0.5">
              <h2 className="text-sm font-semibold">{t("paramsTitle")}</h2>
              <p className="text-xs text-muted-foreground">{t("paramsHint")}</p>
            </div>
            <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
              <FieldShell label={t("labelGpuLayers")} param="gpu_layers">
                <NumInput
                  value={gpuLayers}
                  onChange={setGpuLayers}
                  placeholder={String(defaults.server.gpu_layers)}
                  step="1"
                />
              </FieldShell>
              <FieldShell label={t("labelCtxSize")} param="ctx_size">
                <NumInput
                  value={ctxSize}
                  onChange={setCtxSize}
                  placeholder={String(defaults.server.ctx_size)}
                  step="1"
                />
              </FieldShell>
              <FieldShell label={t("labelCacheK")} param="cache_type_k">
                <Select
                  value={cacheK === "" ? "__default" : cacheK}
                  onValueChange={(v) => setCacheK(v === "__default" ? "" : String(v))}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue>
                      {(v: string) =>
                        v === "__default"
                          ? t("followDefaultValue", { value: defaults.server.cache_type_k })
                          : v
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__default">
                      {t("followDefaultValue", { value: defaults.server.cache_type_k })}
                    </SelectItem>
                    {cacheTypeSchema.options.map((opt) => (
                      <SelectItem key={opt} value={opt}>
                        {opt}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FieldShell>
              <FieldShell label={t("labelTemp")} param="temp">
                <NumInput
                  value={temp}
                  onChange={setTemp}
                  placeholder={String(defaults.server.temp)}
                  step="any"
                />
              </FieldShell>
            </div>
            <div className="flex items-start gap-3 rounded-lg border px-3 py-2.5">
              <Switch checked={autoStart} onCheckedChange={setAutoStart} className="mt-0.5" />
              <div className="flex min-w-0 flex-col gap-0.5">
                <Label className="text-[13px] leading-tight">{t("autoStartLabel")}</Label>
                <p className="text-xs text-muted-foreground">{t("autoStartHint")}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  })();

  // ---- 底部工具条（上一步 / 提示 / 前进动作，随步骤切换） ----
  const showNext =
    step === 1 ||
    (step === 2 && sourceTab === "url") ||
    (step === 3 && !(sourceTab === "hf" && repoFiles !== null && !repoFiles.hasGguf));
  const nextDisabled =
    (step === 1 && !step1Valid) ||
    (step === 2 && sourceTab === "url" && !step2UrlValid) ||
    (step === 3 && !step3Valid);
  const nextLabel = step === 3 ? t("actionNextParams") : t("actionNext");

  const hint =
    step === 3 && sourceTab === "hf" && namespaceValue !== null && totalSelected > 0 ? (
      diskShort ? (
        <span className="text-xs font-medium text-destructive">
          {t("diskShort", { need: formatSize(totalSelected), free: formatSize(diskFree ?? 0) })}
        </span>
      ) : (
        <span className="text-xs text-muted-foreground">
          {t("diskSaveTo", { namespace: namespaceValue })}
          {diskFree !== null ? ` · ${t("diskFree", { size: formatSize(diskFree) })}` : ""}
        </span>
      )
    ) : null;

  return (
    <div className="flex max-w-[820px] flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2.5 w-fit text-muted-foreground"
          render={<Link href="/models" />}
        >
          <ArrowLeft className="size-3.5" />
          {t("backToList")}
        </Button>
        <h1 className="text-base font-semibold tracking-tight">{t("title")}</h1>
      </div>

      <StepBar step={step} onJump={goStep} />

      {submitError !== null && step === 4 && (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 break-words">{submitError}</span>
        </div>
      )}

      {step === 1 && step1Form}
      {step === 2 && step2Form}
      {step === 3 && step3Body}
      {step === 4 && step4Body}

      <div className="flex flex-wrap items-center gap-3">
        {step > 1 && (
          <Button variant="ghost" onClick={() => goStep(step - 1)}>
            <ArrowLeft className="size-3.5" />
            {t("actionPrev")}
          </Button>
        )}
        <span className="min-w-0 flex-1">{hint}</span>
        {step < 4 && showNext && (
          <Button disabled={nextDisabled} onClick={() => goStep(step + 1)}>
            {nextLabel}
            <ArrowRight className="size-3.5" />
          </Button>
        )}
        {step === 4 && (
          <Button disabled={submitting || !step1Valid || !step3Valid} onClick={() => void onSubmit()}>
            {submitting && <Loader2 className="animate-spin" />}
            {submitting ? t("submitting") : t("actionSubmit")}
          </Button>
        )}
      </div>
    </div>
  );
}
