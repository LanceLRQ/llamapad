"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";

import { CreateFolderDialog } from "@/components/create-folder-dialog";
import { Button } from "@/components/ui/button";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { apiFetch } from "@/lib/api";
import {
  DEFAULT_REPO_BASE_DIR,
  initialUrlTargetDir,
  isValidDownloadUrl,
  normalizeFilename,
  repoBaseDirOptions,
  repoSubmitDisabled,
  resolveRepoProbeDisplay,
  urlSubmitDisabled,
  type RepoProbeResult,
} from "@/lib/new-download-dialog";
import { isValidRepoId, repoDirOf } from "@/lib/repo-path";
import { fromSelectValue, ROOT_DIR_OPTION, toSelectValue, withRootFolder } from "@/lib/wizard-target-dir";

type TabKey = "repo" | "url";

/**
 * 统一「新建下载」弹层（批 6 任务 12）：下载解耦成两条路径共用同一个入口——
 * 建仓库档案（结构化落盘 `<base>/<owner>/<repo>/`，成功后跳详情页继续选量化）
 * 或 URL 直链下单个文件（成功后跳下载页看进度）。三处入口（/models 页头、
 * /downloads 页头、/files 面包屑）各自管自己的触发按钮与 open 状态，受控
 * 传进来——三处按钮外观差异太大（图标按钮 / 两种文案的 outline 按钮），
 * 不值得为了共用一个内部触发器反而牺牲各页原有的视觉一致性，做法与
 * app/(panel)/chart-dialog.tsx 的 open/onOpenChange 受控模式一致。
 *
 * 表单状态的「每次打开重置」不走 effect（复核否决：直接在 effect 体内
 * setState 会撞 react-hooks/set-state-in-effect，推迟一拍绕过检查等价于
 * 一条隐形的 eslint-disable，还会在弹层刚打开的那一帧闪一下上一轮的旧值）。
 * 改用 React 官方「用 key 重挂载」的写法：<NewDownloadForm> 整个装着表单
 * 状态，key 由 generation 驱动，每次 open 从 false 变 true 就自增一次
 * （在渲染期同步完成，见下方对 prevOpen 的比较——这是文档认可的「渲染期
 * 调整 state」写法，不进 effect，那条 lint 规则天然不适用）。key 一变
 * React 直接换一个全新实例，全部字段用各自的 useState 初始值重新长出来，
 * 不需要任何一行手工 setXxx("") 去"重置"，也没有"重置该放哪一拍"的问题。
 */
export function NewDownloadDialog({
  open,
  onOpenChange,
  folders,
  defaultBaseDir,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  folders: string[];
  defaultBaseDir?: string;
}) {
  const t = useTranslations("pages.downloads.newDialog");

  const [prevOpen, setPrevOpen] = useState(open);
  const [generation, setGeneration] = useState(0);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) setGeneration((g) => g + 1);
  }

  // 提交请求在途时不许背景点击/Esc 关闭。这个标记只在 Dialog 自己的
  // onOpenChange 回调里读一次，不参与任何渲染输出，用 ref 而不是 state
  // 省一次不必要的重渲染；由内层表单在自己的 setBusy 里同步写入。
  const busyRef = useRef(false);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busyRef.current) onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <NewDownloadForm
          key={generation}
          folders={folders}
          defaultBaseDir={defaultBaseDir}
          onClose={() => onOpenChange(false)}
          onBusyChange={(busy) => {
            busyRef.current = busy;
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

/**
 * 表单本体：两个 Tab 的全部字段状态、探测/提交逻辑。整个组件随外层
 * generation 变化而重新挂载（见上方头注释），因此这里的每一个 useState
 * 初始值就是"打开时应该长成什么样"，不需要额外的重置代码。
 */
function NewDownloadForm({
  folders,
  defaultBaseDir,
  onClose,
  onBusyChange,
}: {
  folders: string[];
  defaultBaseDir?: string;
  onClose: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const t = useTranslations("pages.downloads.newDialog");
  const router = useRouter();

  const [tab, setTab] = useState<TabKey>("repo");
  const [busy, setBusyState] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localFolders, setLocalFolders] = useState<string[]>(folders);
  const [repoDirs, setRepoDirs] = useState<string[]>([]);

  const [repo, setRepo] = useState("");
  const [baseDir, setBaseDir] = useState(DEFAULT_REPO_BASE_DIR);
  const [probePhase, setProbePhase] = useState<"idle" | "loading" | "error">("idle");
  const [probeResult, setProbeResult] = useState<RepoProbeResult | null>(null);
  const [probedRepo, setProbedRepo] = useState<string | null>(null);
  const probeIdRef = useRef(0);

  const [url, setUrl] = useState("");
  const [targetDir, setTargetDir] = useState(() => initialUrlTargetDir(defaultBaseDir, folders));
  const [filename, setFilename] = useState("");

  function setBusy(next: boolean): void {
    setBusyState(next);
    onBusyChange(next);
  }

  // 仓库档案目录清单：只有 URL Tab 的目标目录守卫需要，folders 里的磁盘
  // 目录不等于"哪些目录已经被仓库档案占用"（见组件头注释），三处调用页都
  // 不天然持有这份数据，本组件自己拉一次。本组件整体随弹层每次打开重新
  // 挂载（generation 换 key），这里只需要"挂载时拉一次"，不必再处理
  // "open 变化时重新拉"——AbortController + 效果内本地函数照
  // monitoring/run-history.tsx 的既定写法。
  useEffect(() => {
    const controller = new AbortController();
    async function load(signal: AbortSignal): Promise<void> {
      try {
        const res = await apiFetch("/api/v1/repos", { signal, cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { repos: { targetDir: string }[] };
        setRepoDirs(data.repos.map((p) => p.targetDir));
      } catch (error) {
        if (signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
        // 仅是前端的一道额外提示，拉取失败不弹错：服务端 downloads/direct
        // route 有同款 repoDirOf 检查兜底真正的裁决
      }
    }
    void load(controller.signal);
    return () => controller.abort();
  }, []);

  function handleFolderCreated(path: string, applyTo: "base" | "target"): void {
    setLocalFolders((prev) => (prev.includes(path) ? prev : [...prev, path].sort()));
    if (applyTo === "base") setBaseDir(path);
    else setTargetDir(path);
  }

  async function probeRepo(): Promise<void> {
    const trimmed = repo.trim();
    // 格式已知非法时不发请求：resolveRepoProbeDisplay 会直接判 invalid，
    // 探测结果用不上，省一次白跑的往返
    if (trimmed === "" || !isValidRepoId(trimmed)) return;
    const requestId = ++probeIdRef.current;
    setProbePhase("loading");
    const res = await apiFetch("/api/v1/repos/probe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo: trimmed }),
    }).catch(() => null);
    if (probeIdRef.current !== requestId) return; // 探测期间又发起了新的探测，丢弃这条迟到的结果

    if (res === null || !res.ok) {
      setProbedRepo(trimmed);
      setProbePhase("error");
      return;
    }
    const data = (await res.json()) as RepoProbeResult;
    setProbeResult(data);
    setProbedRepo(trimmed);
    setProbePhase("idle");
  }

  const repoDisplay = resolveRepoProbeDisplay({ repo, baseDir, phase: probePhase, result: probeResult, probedRepo });
  const repoDisabled = repoSubmitDisabled(repoDisplay, baseDir, busy);
  const urlDisabled = urlSubmitDisabled(url, targetDir, repoDirs, busy);
  const urlDirHit = repoDirOf(targetDir, repoDirs);

  async function submitRepo(): Promise<void> {
    if (repoSubmitDisabled(repoDisplay, baseDir, busy)) return;
    setBusy(true);
    setError(null);
    const res = await apiFetch("/api/v1/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo: repo.trim(), baseDir }),
    }).catch(() => null);

    if (res === null) {
      setBusy(false);
      setError(t("errorNetwork"));
      return;
    }
    if (res.ok) {
      const created = (await res.json()) as { id: number };
      onClose();
      router.push(`/models/repos/${created.id}`);
      return;
    }
    setBusy(false);
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    switch (body?.error) {
      case "CONFLICT":
        setError(t("errorConflict"));
        break;
      case "INVALID_NAME":
      case "invalid_body":
        setError(t("errorInvalid"));
        break;
      default:
        setError(t("errorRequest"));
    }
  }

  async function submitUrl(): Promise<void> {
    if (urlSubmitDisabled(url, targetDir, repoDirs, busy)) return;
    setBusy(true);
    setError(null);
    const res = await apiFetch("/api/v1/downloads/direct", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: url.trim(), targetDir, filename: normalizeFilename(filename) }),
    }).catch(() => null);

    if (res === null) {
      setBusy(false);
      setError(t("errorNetwork"));
      return;
    }
    if (res.status === 202) {
      onClose();
      router.push("/downloads");
      return;
    }
    setBusy(false);
    const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
    if (body?.error === "invalid_body") {
      setError(t("errorInvalid"));
    } else if (body?.error === "INVALID_PATH") {
      setError(body.message ?? t("errorRequest"));
    } else {
      setError(body?.error ?? t("errorRequest"));
    }
  }

  return (
    <>
      <Tabs
        value={tab}
        onValueChange={(v) => {
          if (v !== "repo" && v !== "url") return;
          setTab(v);
          setError(null);
        }}
      >
        <TabsList>
          <TabsTrigger value="repo" disabled={busy}>
            {t("tabRepo")}
          </TabsTrigger>
          <TabsTrigger value="url" disabled={busy}>
            {t("tabUrl")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="repo" className="flex flex-col gap-3 pt-2">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">{t("repoLabel")}</span>
            <Input
              className="font-mono"
              value={repo}
              placeholder={t("repoPlaceholder")}
              onChange={(e) => setRepo(e.target.value)}
              onBlur={() => void probeRepo()}
              aria-invalid={repoDisplay.kind === "invalid"}
              autoFocus
            />
            {repoDisplay.kind === "invalid" && <p className="text-xs text-destructive">{t("repoInvalid")}</p>}
            {repoDisplay.kind === "loading" && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="size-3 animate-spin" />
                {t("repoProbing")}
              </p>
            )}
            {repoDisplay.kind === "error" && <p className="text-xs text-muted-foreground">{t("repoProbeError")}</p>}
            {repoDisplay.kind === "exists" && (
              <p className="flex flex-wrap items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                {t("repoExists", { dir: repoDisplay.targetDir })}
                <Link href={`/models/repos/${repoDisplay.id}`} className="underline underline-offset-2">
                  {t("repoExistsLink")}
                </Link>
              </p>
            )}
            {repoDisplay.kind === "orphan" && (
              <p className="text-xs text-muted-foreground">{t("repoOrphan", { dir: repoDisplay.targetDir })}</p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">{t("baseDirLabel")}</span>
            <div className="flex gap-2">
              <Select value={toSelectValue(baseDir)} onValueChange={(v) => setBaseDir(fromSelectValue(String(v)))}>
                <SelectTrigger className="w-full font-mono">
                  <SelectValue placeholder={t("baseDirPlaceholder")}>
                    {(v: string) => (v === ROOT_DIR_OPTION ? t("rootDir") : v)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {repoBaseDirOptions(localFolders).map((dir) => (
                    <SelectItem key={toSelectValue(dir)} value={toSelectValue(dir)}>
                      {dir === "" ? t("rootDir") : dir}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <CreateFolderDialog parentPath={baseDir} onCreated={(path) => handleFolderCreated(path, "base")} />
            </div>
          </div>
        </TabsContent>

        <TabsContent value="url" className="flex flex-col gap-3 pt-2">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">{t("urlLabel")}</span>
            <Input
              className="font-mono"
              value={url}
              placeholder={t("urlPlaceholder")}
              onChange={(e) => setUrl(e.target.value)}
              aria-invalid={url.trim() !== "" && !isValidDownloadUrl(url)}
              autoFocus
            />
            {url.trim() !== "" && !isValidDownloadUrl(url) && (
              <p className="text-xs text-destructive">{t("urlInvalid")}</p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">{t("targetDirLabel")}</span>
            <div className="flex gap-2">
              <Select value={toSelectValue(targetDir)} onValueChange={(v) => setTargetDir(fromSelectValue(String(v)))}>
                <SelectTrigger className="w-full font-mono">
                  <SelectValue placeholder={t("targetDirPlaceholder")}>
                    {(v: string) => (v === ROOT_DIR_OPTION ? t("rootDir") : v)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {withRootFolder(localFolders).map((dir) => (
                    <SelectItem key={toSelectValue(dir)} value={toSelectValue(dir)}>
                      {dir === "" ? t("rootDir") : dir}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <CreateFolderDialog parentPath={targetDir} onCreated={(path) => handleFolderCreated(path, "target")} />
            </div>
            {urlDirHit !== null && <p className="text-xs text-destructive">{t("urlDirBlocked", { dir: urlDirHit })}</p>}
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">{t("filenameLabel")}</span>
            <Input
              className="font-mono"
              value={filename}
              placeholder={t("filenamePlaceholder")}
              onChange={(e) => setFilename(e.target.value)}
            />
          </div>
        </TabsContent>
      </Tabs>

      {error && <p className="text-xs text-destructive">{error}</p>}

      <DialogFooter>
        <DialogClose render={<Button variant="outline" disabled={busy} />}>{t("cancel")}</DialogClose>
        {tab === "repo" ? (
          <Button disabled={repoDisabled} onClick={() => void submitRepo()}>
            {busy && <Loader2 className="animate-spin" />}
            {busy ? t("submitting") : t("submitRepo")}
          </Button>
        ) : (
          <Button disabled={urlDisabled} onClick={() => void submitUrl()}>
            {busy && <Loader2 className="animate-spin" />}
            {busy ? t("submitting") : t("submitUrl")}
          </Button>
        )}
      </DialogFooter>
    </>
  );
}
