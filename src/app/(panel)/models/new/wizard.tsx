"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { ArrowLeft, ArrowRight, Link2, Loader2, Plus, Search, TriangleAlert } from "lucide-react";

import { cacheTypeSchema, type DefaultConfig, type Overrides } from "@/core/schemas";
import { PageHeader } from "@/components/shell/page-header";
import { SecondaryNav } from "@/components/shell/secondary-nav";
import { formatSize, toGigabytes } from "@/lib/format";
import { pathForGroup } from "@/lib/model-file-picker";
import { DEFAULT_OPTION, toFloatOrNull, toIntOrNull } from "@/lib/model-form";
import { PARAM_PRESET_IDS, presetDraftPatch } from "@/lib/param-presets";
import { WIZARD_STEPS, resolveWizardStep, wizardStepState, type WizardStepState } from "@/lib/wizard-steps";
import {
  fromSelectValue,
  joinDirPath,
  resolveInitialFolder,
  ROOT_DIR_OPTION,
  toSelectValue,
  withRootFolder,
} from "@/lib/wizard-target-dir";
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
import { apiFetch } from "@/lib/api";
import { ParamTip } from "@/components/param-tip";
import { CreateFolderDialog } from "@/components/create-folder-dialog";
import { NamespaceCreateDialog } from "@/components/namespace-create-dialog";

/**
 * 新建模型向导（M2 Task 7，client 四步；M16 T8 改二级栏门禁 + `?step=` 深链）：
 * 1 名称·空间 → 2 来源（HF 仓库 / URL 直链 Tab）→ 3 文件（量化分组 RadioCard
 * 选择 + mmproj 独立勾选 + 存放位置 + 磁盘预检）→ 4 参数（overrides 精简
 * 表单 + 摘要）。
 *
 * 命名空间与存放位置彻底解耦（阶段 4 D1/D2）：第 1 步的命名空间只是模型
 * 配置的分组标签，第 3 步的存放位置才是文件落盘的磁盘目录，二者各自独立
 * 的 state（namespace / targetDir），互不联动——选了命名空间不会预填存放
 * 位置，反之亦然。derivePlan 里 gguf_file/mmproj_file 由 targetDir 拼出，
 * namespace 只进 model.namespace 一个字段。
 *
 * 步骤门禁语义对照 lib/wizard-steps.ts：done=绿勾可回退（meta 回填已填值）、
 * current=选中态、locked=灰不可点。仅在当前步校验通过后才能前进（HF 模式的
 * 前进动作是「浏览文件」成功本身）。
 *
 * step 由 URL 派生而非独立 state：`maxReached`（只增不减，刷新重置为 1）
 * 记录本次会话已解锁到第几步，`resolveWizardStep` 据此把 `?step=` 夹到
 * 可达范围内——深链能带你回到已经走过的步，不能凭空把你送进一个没有前置
 * 数据的步。goStep 前进/回退一律 router.replace（不 push），向导内部切换
 * 不该塞满浏览器后退栈，与 SecondaryNav 内部的做法一致。
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
/** 命名空间 Select 的「＋新建空间」哨兵（与 @/lib/model-form 的 DEFAULT_OPTION 同惯例） */
const NEW_NAMESPACE_OPTION = "__new__";

/** URL 末段（去 query、decode）；解析失败返回空串 */
function lastSegmentOfUrl(u: string): string {
  try {
    const seg = new URL(u).pathname.split("/").filter(Boolean).pop() ?? "";
    return decodeURIComponent(seg);
  } catch {
    return "";
  }
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

/** 表单字段外壳（与 model-params-form.tsx 的 FieldShell 同语义，含 U20 Info 提示） */
function FieldShell({
  label,
  param,
  hint,
  tip,
  error,
  children,
}: {
  label: string;
  param?: string;
  hint?: string;
  /** 参数一句话解释（U20），Label 右侧 Info 图标 hover/focus 显示 */
  tip?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-baseline gap-1">
        <Label className="items-baseline">
          <span>{label}</span>
          {param && (
            <code className="font-mono text-[11px] font-normal text-muted-foreground">{param}</code>
          )}
        </Label>
        {tip && <ParamTip text={tip} />}
      </div>
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
        {/* 缺片是 A 级风险——选了缺片的组，下载完模型也起不来，必须红条常驻，
            不能收进 hover 悬停：这条警告不受选中态控制，只要该组声明分片数
            与仓库实有文件数对不上就一直显示 */}
        {warning && (
          <span
            role="alert"
            className="flex items-center gap-1.5 rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-xs font-medium text-destructive"
          >
            <TriangleAlert className="size-3.5 shrink-0" />
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
  const tc = useTranslations("common");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  /** 本次会话已解锁到第几步（只增不减，页面刷新重置为 1——向导没有可恢复的
   * 半成品状态）；实际渲染的 step 由 `?step=` 经门禁夹出，深链指向未解锁的
   * 步会回落到这里 */
  const [maxReached, setMaxReached] = useState(1);
  const step = resolveWizardStep(searchParams.get("step") ?? undefined, maxReached);
  /** 提交期错误横幅（模型创建 / 下载入队两阶段共用，文案带阶段前缀） */
  const [submitError, setSubmitError] = useState<string | null>(null);

  // ---- Step 1：名称 · 空间 ----
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [namespaces, setNamespaces] = useState(initialNamespaces);
  const [namespace, setNamespace] = useState(
    initialNamespaces[0]?.name ?? "main",
  );
  /** 「新建命名空间」弹层（阶段 4 D4）的开合，与 Select 自身的选中值分开
   * 持有——选中哨兵项只弹窗，不改 namespace，取消后不会露出"新建中"的
   * 中间态 */
  const [namespaceDialogOpen, setNamespaceDialogOpen] = useState(false);
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

  /** 命名空间新建成功后的回调：拉回列表（拿到服务端权威的 createdAt/bytes，
   * 不在本地拼一份）并切到新空间——弹层内部状态（busy/error）全部交给
   * NamespaceCreateDialog 自己管，这里只关心"建完了，然后呢" */
  async function onNamespaceCreated(name: string): Promise<void> {
    const list = await apiFetch("/api/v1/namespaces", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    if (list) setNamespaces(list.namespaces as NamespaceEntry[]);
    setNamespace(name);
  }

  const step1Valid = nameValid && !nameTaken;

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
    goStep(3);
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

  /** 存放位置（D1）：与命名空间彻底独立的 state，不从 namespace 派生。
   * 初始给 [""]/"" 而不是空数组/null——首次渲染时 Select 至少有"根目录"
   * 一项可选，避免值与选项都为空的一瞬间闪烁；GET /api/v1/folders 回来后
   * 用真实清单覆盖 */
  const [folders, setFolders] = useState<string[]>([""]);
  const [targetDir, setTargetDir] = useState("");
  /** 用户是否手动选过存放位置（Select 选择 / 新建文件夹都算）：进入过一次
   * 就不再被"进入第 3 步刷新目录清单"这件事顺带覆盖回默认值 */
  const targetDirTouchedRef = useRef(false);

  useEffect(() => {
    if (step !== 3) return;
    apiFetch("/api/v1/folders", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { folders: string[] } | null) => {
        if (!d) return;
        setFolders(d.folders);
        if (!targetDirTouchedRef.current) {
          setTargetDir(resolveInitialFolder(searchParams.get("dir"), d.folders));
        }
      })
      .catch(() => {});
    // searchParams 只在这里取一次 `dir` 深链值（首次命中后 targetDirTouchedRef
    // 就会拦住后续覆盖），目录清单本身才是"每次进入第 3 步都值得刷新"的东西，
    // 不该因为 step 之外的 query 变化（如切换 sourceTab 帯的其它参数）重新拉一遍
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  /** 新建文件夹（复用文件页共享的弹层组件）成功后：并入清单、选中它、
   * 标记为"已手动选过"，避免下一次进入第 3 步的目录清单刷新把它冲掉 */
  function handleFolderCreated(path: string): void {
    setFolders((prev) => (prev.includes(path) ? prev : [...prev, path].sort()));
    setTargetDir(path);
    targetDirTouchedRef.current = true;
  }

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

  /** 由当前选择推导提交 payload（摘要卡与提交共用，保证所见即所存）。
   * gguf_file/mmproj_file 由 targetDir 拼出，namespace 只落 model.namespace
   * 一个字段——两者阶段 4 起彻底独立，不再互相推导（见文件头注释） */
  function derivePlan(): SubmitPlan {
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
      const glob = pathForGroup(selected.files);
      const files = selected.files.map(toDownloadFile);
      let mmprojFile: string | undefined;
      if (mmproj !== undefined) {
        mmprojFile = joinDirPath(targetDir, pathForGroup(mmproj.files));
        files.push(...mmproj.files.map(toDownloadFile));
      }
      return {
        model: {
          name,
          display_name: displayName.trim() || name,
          namespace,
          gguf_file: joinDirPath(targetDir, glob),
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
        namespace,
        gguf_file: joinDirPath(targetDir, file),
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

    // targetDir 显式传：服务端不传时会从 gguf_file 反推目录，那条兜底是给
    // "重新下载既有模型"用的；向导这里用户已经明确选过存放位置，直接传更
    // 清晰，也避免 gguf_file 拼接与落盘目录两处各算一遍而可能不一致（阶段 4 D1）
    const dl = await apiFetch(`/api/v1/models/${encodeURIComponent(plan.model.name)}/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files: plan.files, targetDir }),
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

  /** 切步：先把 maxReached 抬到 next（只增不减），再 router.replace 写
   * `?step=`——replace 不 push，向导内前进/后退不该塞满浏览器后退栈 */
  function goStep(next: number): void {
    setMaxReached((m) => Math.max(m, next));
    const params = new URLSearchParams(searchParams.toString());
    params.set("step", String(next));
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
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
          <Select
            value={namespace}
            onValueChange={(v) => {
              const value = String(v);
              // 选中"＋新建空间"只弹层，不改 namespace：Select 视觉上停在原
              // 选项，取消弹层不会露出一个"新建中"的中间态（阶段 4 D4）
              if (value === NEW_NAMESPACE_OPTION) {
                setNamespaceDialogOpen(true);
                return;
              }
              setNamespace(value);
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue>{(v: string) => v}</SelectValue>
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
        </FieldShell>
      </CardContent>
      <NamespaceCreateDialog
        open={namespaceDialogOpen}
        onOpenChange={setNamespaceDialogOpen}
        onCreated={(name) => void onNamespaceCreated(name)}
      />
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

  /** 存放位置控件（D1，HF/URL 两个分支共用）：下拉选择既有目录 + 新建文件夹
   * （复用文件页共享的弹层组件）；previewName 传当前已经确定的文件名/glob，
   * 为 null（还没选到具体文件）时只渲染选择器，不回显一条拼不出内容的路径。 */
  function renderTargetDirField(previewName: string | null): ReactNode {
    return (
      <div className="flex flex-col gap-1.5">
        <FieldShell label={t("targetDirLabel")} hint={t("targetDirHint")}>
          <div className="flex gap-2">
            <Select
              value={toSelectValue(targetDir)}
              onValueChange={(v) => {
                setTargetDir(fromSelectValue(String(v)));
                targetDirTouchedRef.current = true;
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue>
                  {(v: string) => (v === ROOT_DIR_OPTION ? tc("filePicker.rootGroupLabel") : v)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {withRootFolder(folders).map((dir) => (
                  <SelectItem key={toSelectValue(dir)} value={toSelectValue(dir)}>
                    {dir === "" ? tc("filePicker.rootGroupLabel") : dir}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <CreateFolderDialog parentPath={targetDir} onCreated={handleFolderCreated} />
          </div>
        </FieldShell>
        {previewName !== null && (
          <p className="font-mono text-xs text-muted-foreground break-all">
            {t("targetDirPreview", { path: joinDirPath(targetDir, previewName) })}
          </p>
        )}
      </div>
    );
  }

  /** Step 3 主体：HF=分组选择；URL=单文件预览；hasGguf=false=整页提示 */
  const step3Body = (() => {
    if (sourceTab === "url") {
      return (
        <div className="flex flex-col gap-3.5">
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
          {renderTargetDirField(urlFile.trim() !== "" ? urlFile.trim() : null)}
        </div>
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

        {/* D6：按屏幕宽度自适应列数，充分利用宽屏空间；items-start 让每张卡
            按自己的内容决定高度——缺片警告是块级元素，grid 默认的 stretch
            会把同一行里没有警告的卡片也拉到警告卡片的高度，看起来像是布局
            跳动。mmproj 组（下方另一个容器）label 是完整文件路径、数量通常
            只有一两个，保持单列，不套用这个断点。

            分列断点取 lg(1024px) 而不是 sm(640px)：断点按视口宽度判定，而卡片
            实际可用的宽度是内容区宽度——视口还要先减去侧栏 236px 与二级栏，
            768px 视口下内容区只剩约 370px，此时分两列每列不到 180px，meta 行
            （"5.8 GB · 1 个文件"）会全部被 truncate 吃掉。实测：sm 断点下
            768px/640px 处 6 张卡的 meta 全截断，而分列之前的单列布局在同样
            宽度下一条都不截断——那等于用"一行多个"换掉了"看得清是什么"。
            lg 起分两列时每列 306px、2xl 起三列时每列 393px，实测零截断。 */}
        <div
          role="radiogroup"
          aria-label={t("selectGroupLabel")}
          className="grid grid-cols-1 items-start gap-2.5 lg:grid-cols-2 2xl:grid-cols-3"
        >
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

        {renderTargetDirField(selected !== undefined ? pathForGroup(selected.files) : null)}

        {/* 磁盘预检：已选组才有意义显示。磁盘不足同为 A 级风险，红条常驻，
            不再塞进底部工具条与其他提示文字混在一起——与缺片警告同一视觉重量 */}
        {totalSelected > 0 && (
          diskShort ? (
            <div
              role="alert"
              className="flex items-start gap-2.5 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
            >
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              <span className="min-w-0 break-words">
                {t("diskShort", { need: formatSize(totalSelected), free: formatSize(diskFree ?? 0) })}
              </span>
            </div>
          ) : (
            <p className="font-mono text-xs text-muted-foreground">
              {t("diskSaveTo", { path: targetDir === "" ? tc("filePicker.rootGroupLabel") : targetDir })}
              {diskFree !== null ? ` · ${t("diskFree", { size: formatSize(diskFree) })}` : ""}
            </p>
          )
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
            <div className="flex flex-wrap items-baseline gap-2">
              <div className="flex flex-col gap-0.5">
                <h2 className="text-sm font-semibold">{t("paramsTitle")}</h2>
                <p className="text-xs text-muted-foreground">{t("paramsHint")}</p>
              </div>
              <span className="ml-auto flex items-center gap-1.5">
                <span className="text-[11px] text-muted-foreground">
                  {tc("paramPresets.title")}
                </span>
                {PARAM_PRESET_IDS.map((id) => (
                  <Button
                    key={id}
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    title={tc(`paramPresets.${id}Hint`)}
                    onClick={() => {
                      // 向导只有 gpu_layers / cache_type_k 两键在场，逐字段落
                      const p = presetDraftPatch(id);
                      setGpuLayers(p.gpuLayers ?? "");
                      setCacheK(p.cacheK ?? "");
                    }}
                  >
                    {tc(`paramPresets.${id}`)}
                  </Button>
                ))}
              </span>
            </div>
            <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
              <FieldShell label={t("labelGpuLayers")} tip={tc("paramHints.gpu_layers")} param="gpu_layers">
                <NumInput
                  value={gpuLayers}
                  onChange={setGpuLayers}
                  placeholder={String(defaults.server.gpu_layers)}
                  step="1"
                />
              </FieldShell>
              <FieldShell label={t("labelCtxSize")} tip={tc("paramHints.ctx_size")} param="ctx_size">
                <NumInput
                  value={ctxSize}
                  onChange={setCtxSize}
                  placeholder={String(defaults.server.ctx_size)}
                  step="1"
                />
              </FieldShell>
              <FieldShell label={t("labelCacheK")} tip={tc("paramHints.cache_type_k")} param="cache_type_k">
                <Select
                  value={cacheK === "" ? DEFAULT_OPTION : cacheK}
                  onValueChange={(v) => setCacheK(v === DEFAULT_OPTION ? "" : String(v))}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue>
                      {(v: string) =>
                        v === DEFAULT_OPTION
                          ? t("followDefaultValue", { value: defaults.server.cache_type_k })
                          : v
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={DEFAULT_OPTION}>
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
              <FieldShell label={t("labelTemp")} tip={tc("paramHints.temp")} param="temp">
                <NumInput
                  value={temp}
                  onChange={setTemp}
                  placeholder={String(defaults.server.temp)}
                  step="any"
                />
              </FieldShell>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  })();

  // ---- 底部工具条（上一步 / 前进动作，随步骤切换；A 级警告已升格进各步内容，
  // 不再塞在这条工具条里——工具条现在纯粹是流程控件） ----
  const showNext =
    step === 1 ||
    (step === 2 && sourceTab === "url") ||
    (step === 3 && !(sourceTab === "hf" && repoFiles !== null && !repoFiles.hasGguf));
  const nextDisabled =
    (step === 1 && !step1Valid) ||
    (step === 2 && sourceTab === "url" && !step2UrlValid) ||
    (step === 3 && !step3Valid);
  const nextLabel = step === 3 ? t("actionNextParams") : t("actionNext");

  // ---- 二级栏（M16 T8）：四步固定有序集合，编号语义与设置页一致，
  // 只是多一层门禁三态。meta 回填已填值是这一栏相对旧 StepBar 的主要价值——
  // 「未填」一律给 undefined 而不是占位符，"还没到"和"已经是空"是两件事 ----
  const stepNames = [t("step1"), t("step2"), t("step3"), t("step4")];
  const step1Meta = name.trim() !== "" ? `${name.trim()} · ${namespace}` : undefined;
  const step2Meta =
    sourceTab === "hf"
      ? repo.trim() !== ""
        ? t("navMetaSourceHf", { repo: repo.trim() })
        : undefined
      : urlParsed !== null
        ? t("navMetaSourceUrl", { host: urlParsed.hostname })
        : undefined;
  const step3Meta =
    sourceTab === "hf"
      ? repoFiles !== null
        ? t("navMetaGroups", { count: modelGroups.length })
        : undefined
      : urlFile.trim() !== ""
        ? urlFile.trim()
        : undefined;
  const stepMetas: (string | undefined)[] = [step1Meta, step2Meta, step3Meta, undefined];

  const navItems = WIZARD_STEPS.map((n, i) => {
    const state: WizardStepState = wizardStepState(n, step, maxReached);
    return {
      key: String(n),
      name: stepNames[i]!,
      lead: { kind: "number" as const, text: String(n).padStart(2, "0") },
      meta: stepMetas[i],
      state: state === "current" ? undefined : state,
      title: state === "done" ? t("stepDoneTooltip") : state === "locked" ? t("stepLockedTooltip") : undefined,
    };
  });

  // 磁盘剩余可能到 TB 量级，与「待下载」固定 GB 单位不同——这里不拆数值/单位
  // 两截，直接把 formatSize 的整串（含单位）放进 value，不传 unit；
  // null（磁盘总量未知）原样传给 formatStat 走它的空态判断
  const diskFreeStat = diskFree === null ? null : formatSize(diskFree);

  return (
    // 二级栏必须贴到应用外壳的框边：main 给 px-[34px] pt-7 pb-12，本页在这一层
    // 用负边距抵消掉（T1→T11 迁移期的过渡做法，对齐设置页/模型页/文件页，
    // T4b 之后各页统一处理，届时这段注释与负边距一起删）
    //
    // h- 而非 min-h-：min-h-full 只等于 main 的内容盒（不含抵消掉的
    // pt-7 28 + pb-12 48 = 76px），二级栏右边框会停在离底 76px 处；定高后
    // 内容不再撑长 main，中段表单区改由自己滚动，底部上一步/下一步工具条
    // 固定不滚（见下方 overflow-y-auto 与其后紧跟的 border-t 工具条）
    <div className="-mx-[34px] -mt-7 -mb-12 flex h-[calc(100%+76px)]">
      <SecondaryNav
        kicker="NEW MODEL"
        title={t("title")}
        items={navItems}
        queryKey="step"
        current={String(step)}
        footer={
          <div className="flex flex-col gap-3 px-4 pt-3.5 pb-4">
            <Button
              variant="ghost"
              size="sm"
              className="-ml-1 w-fit text-muted-foreground"
              nativeButton={false}
              render={<Link href="/models" />}
            >
              <ArrowLeft className="size-3.5" />
              {t("backToList")}
            </Button>
            <p className="text-xs text-muted-foreground">
              {t.rich("deeplinkHint", {
                code: (chunks) => (
                  <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground">
                    {chunks}
                  </code>
                ),
              })}
            </p>
          </div>
        }
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <PageHeader
          icon={Plus}
          title={t("title")}
          subtitle={t("subtitleStep", { name: stepNames[step - 1]! })}
          stats={[
            // unit 不带前导空格：PageHeader 的 unit span 自带 ml-1，字符串里再留一个
            // 空格会比同排「待下载 GB」那格宽出一截
            { value: step, unit: "/ 4", label: t("statStep"), tone: "hot" },
            { value: toGigabytes(totalSelected), unit: "GB", label: t("statPending") },
            { value: diskFreeStat, label: t("statDiskFree") },
          ]}
        />

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-7 py-6">
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
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t px-7 py-4">
          {step > 1 && (
            <Button variant="ghost" onClick={() => goStep(step - 1)}>
              <ArrowLeft className="size-3.5" />
              {t("actionPrev")}
            </Button>
          )}
          <span className="min-w-0 flex-1" />
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
    </div>
  );
}
