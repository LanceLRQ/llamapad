"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { FileText, Loader2, Lock, RefreshCw, TriangleAlert } from "lucide-react";

import type { ServerConfig } from "@/core/schemas";
import { RecommendProfileCard } from "@/components/models/recommend-profile-card";
import { Markdown } from "@/components/markdown";
import { toast } from "@/components/toast-store";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api";
import type { RecommendedProfile } from "@/lib/readme-params";
import { resolveReadmeUrl } from "@/lib/readme-links";
import { REPO_README_LANDING_KEY } from "@/lib/repo-readme-tabs";

/** 与 GET /api/v1/repos/:id/readme 响应逐字段对齐（该路由 JSDoc 写了完整形状） */
export interface ReadmeResponse {
  repo: string;
  content: string | null;
  badges: { key: string; value: string }[];
  endpoint: string;
  truncated: boolean;
  fetchedAt: number;
  profiles: unknown[];
  profilesEngine: string | null;
  error: { kind: "notFound" | "unauthorized" | "network"; message: string } | null;
}

/** 徽章 key → i18n 键；未知 key 不渲染（后端加字段不会让前端崩） */
const BADGE_LABEL: Record<string, string> = {
  license: "badgeLicense",
  base_model: "badgeBaseModel",
  pipeline_tag: "badgePipelineTag",
  tags: "badgeTags",
};

/**
 * 档案详情页的 README 视图（HF README 视图）
 *
 * 挂载后自己 fetch（缓存为空时服务端会同步拉一次），期间显示加载态。
 * **失败不白屏**：有旧缓存就照常渲染正文，只在顶部挂一条提示——与同目录
 * repo-detail-view.tsx 的降级原则一致。
 */
export function ReadmeView({
  repoId,
  effective,
  landingReadme,
  onGoFiles,
  onApplyRecommend,
  onProfilesLoaded,
}: {
  repoId: number;
  /** 当前生效的 server 配置（全局默认，档案页没有具体模型上下文），
   *  用作推荐卡「当前值」列与 diff 基准 */
  effective: ServerConfig;
  /** SSR 传入的当前设置值，用作复选框初值 */
  landingReadme: boolean;
  /** 勾了「下次直接进文件列表」后，用户点空态里的「去文件列表」时调用 */
  onGoFiles: () => void;
  /** 用户在某套推荐卡上点了「应用到建配置」：把选中的字段集合连同 profile.id
   *  交给上层——切到文件视图、决定预选哪一套是 T19 BatchCreateDialog 的职责 */
  onApplyRecommend: (profileId: string, server: Partial<ServerConfig>) => void;
  /** README 解析出的推荐参数集，每次 fetch 成功后上报一次——BatchCreateDialog
   *  的「本仓库推荐」下拉组要用（T19）。本组件不挂载时（切到文件视图）
   *  上层拿不到新数据，这是刻意的：不为填充一个下拉分组去在文件视图自动
   *  请求 README 接口，那条路由缓存为空时会同步打一次 HF 网络往返 */
  onProfilesLoaded: (profiles: RecommendedProfile[]) => void;
}) {
  const t = useTranslations("pages.repos");
  const [data, setData] = useState<ReadmeResponse | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "loaded" | "error">("loading");
  const [refreshing, setRefreshing] = useState(false);
  const [skipLanding, setSkipLanding] = useState(!landingReadme);
  // 「存为预设」弹层：非空 = 打开，装着待存的字段集合与默认名（用户仍可改名）
  const [savePreset, setSavePreset] = useState<{ server: Partial<ServerConfig>; name: string } | null>(null);

  // 与 repo-detail-view.tsx 同一形状：刷新与首载共用一条请求路径，
  // 乱序回来的旧响应不许覆盖新数据
  const controllerRef = useRef<AbortController | null>(null);

  const load = useCallback(
    async (refresh: boolean) => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      try {
        const res = await apiFetch(
          `/api/v1/repos/${repoId}/readme${refresh ? "?refresh=1" : ""}`,
          { signal: controller.signal, cache: "no-store" },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as ReadmeResponse;
        setData(body);
        onProfilesLoaded(body.profiles as RecommendedProfile[]);
        setLoadState("loaded");
      } catch (error) {
        if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
          return;
        }
        setLoadState("error");
      }
    },
    [repoId, onProfilesLoaded],
  );

  useEffect(() => {
    const tick = () => void load(false);
    tick();
    return () => controllerRef.current?.abort();
  }, [load]);

  // 内联函数字面量会让 memo 过的 Markdown 每次 render 都 miss——勾选「下次直接
  // 进文件列表」、开关「存为预设」弹层都会触发这个组件重渲染，进而让整篇
  // README（上限 256KB）重新解析 + rehype-highlight 重新高亮。只在真正用到的
  // 两个字段变化时才产出新函数引用。必须放在任何早返回之前——下面 loading/
  // error 分支的早返回不能让这个 hook 在有的渲染里被跳过（Rules of Hooks）。
  // 先把用到的两个字段解出来再传给 deps——直接在闭包体里访问 data.repo /
  // data.endpoint 会让 exhaustive-deps 要求把整个 data 对象放进依赖数组，
  // 那样 data 里任何其他字段（如 fetchedAt）变化也会白白产出新函数引用。
  const readmeRepo = data?.repo;
  const readmeEndpoint = data?.endpoint;
  const urlTransform = useCallback(
    (url: string, key: string) =>
      readmeRepo === undefined || readmeEndpoint === undefined
        ? ""
        : (resolveReadmeUrl(url, {
            repo: readmeRepo,
            endpoint: readmeEndpoint,
            kind: key === "src" ? "image" : "link",
          }) ?? ""),
    [readmeRepo, readmeEndpoint],
  );

  async function onRefresh(): Promise<void> {
    if (refreshing) return;
    setRefreshing(true);
    await load(true);
    setRefreshing(false);
  }

  function onToggleSkip(next: boolean): void {
    setSkipLanding(next);
    // fire-and-forget：这是个偏好位，写失败不该打断阅读（与 onboarding_playground_seen 同款）
    void apiFetch(`/api/v1/settings/${REPO_README_LANDING_KEY}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: next ? "0" : "1" }),
    }).catch(() => toast.error(t("errorRequest")));
  }

  if (loadState === "loading") {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        {t("readmeLoading")}
      </div>
    );
  }

  if (loadState === "error" || data === null) {
    return (
      <Card>
        <CardContent className="flex flex-col items-start gap-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <TriangleAlert className="size-4 text-destructive" />
            {t("readmeNetworkTitle")}
          </div>
          <p className="text-sm text-muted-foreground">{t("readmeNetworkDescription")}</p>
          <Button size="sm" variant="outline" onClick={() => void load(true)}>
            <RefreshCw className="size-3.5" />
            {t("detailRetry")}
          </Button>
        </CardContent>
      </Card>
    );
  }

  const hasContent = data.content !== null && data.content.trim() !== "";
  // 「存为预设」的默认名要带上仓库基名（owner/name 的 name 部分）——见 lib/suggested-preset-name.ts
  const repoBaseName = data.repo.split("/").pop() ?? data.repo;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {data.badges.map((badge) =>
          BADGE_LABEL[badge.key] === undefined ? null : (
            <Badge key={badge.key} variant="outline" className="font-normal">
              <span className="text-muted-foreground">{t(BADGE_LABEL[badge.key])}</span>
              <span className="ml-1.5">{badge.value}</span>
            </Badge>
          ),
        )}
        <span className="ml-auto flex items-center gap-2">
          {data.fetchedAt > 0 && (
            <span className="text-[11px] text-muted-foreground">
              {t("readmeUpdatedAt", { time: new Date(data.fetchedAt).toLocaleString() })}
            </span>
          )}
          <Button size="sm" variant="outline" disabled={refreshing} onClick={() => void onRefresh()}>
            {refreshing ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            {t("readmeRefresh")}
          </Button>
        </span>
      </div>

      {data.profiles.length > 0 && (
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold">{t("recommendFound", { count: data.profiles.length })}</h2>
          {(data.profiles as RecommendedProfile[]).map((profile) => (
            <RecommendProfileCard
              key={profile.id}
              profile={profile}
              effective={effective}
              repoBaseName={repoBaseName}
              onApply={(server) => onApplyRecommend(profile.id, server)}
              onSaveAsPreset={(server, name) => setSavePreset({ server, name })}
            />
          ))}
        </div>
      )}

      {data.error !== null && data.error.kind === "network" && hasContent && (
        <p className="text-xs text-destructive">{t("readmeRefreshFailed")}</p>
      )}
      {data.truncated && <p className="text-xs text-muted-foreground">{t("readmeTruncated")}</p>}

      {data.error?.kind === "unauthorized" && !hasContent ? (
        <Card>
          <CardContent className="flex flex-col items-start gap-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Lock className="size-4" />
              {t("readmeUnauthorizedTitle")}
            </div>
            <p className="text-sm text-muted-foreground">{t("readmeUnauthorizedDescription")}</p>
            {/* 本仓 Button 是 Base UI 形态，没有 asChild，跳转用 render={<Link/>}
                （与 repo-detail-view.tsx 的「创建配置」同一写法）。深链给
                tab=library——HF Token 卡在设置页「资料库」组，非法 tab 会被
                resolveSettingsTab 兜底到 runtime，等于没带用户去目的地 */}
            <Button
              size="sm"
              variant="outline"
              nativeButton={false}
              render={<Link href="/settings?tab=library" />}
            >
              {t("readmeUnauthorizedAction")}
            </Button>
          </CardContent>
        </Card>
      ) : hasContent ? (
        <Markdown text={data.content ?? ""} className="max-w-none" urlTransform={urlTransform} />
      ) : (
        <Card>
          <CardContent className="flex flex-col items-start gap-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <FileText className="size-4" />
              {t("readmeEmptyTitle")}
            </div>
            {/* 措辞刻意不像「解析失败」：实测 12 个样本里有 6 个确实没写，
                这是常态不是故障，说成故障会让用户反复刷新 */}
            <p className="text-sm text-muted-foreground">{t("readmeEmptyDescription")}</p>
            <Button size="sm" variant="outline" onClick={onGoFiles}>
              {t("views.files.name")}
            </Button>
          </CardContent>
        </Card>
      )}

      <label className="flex items-center gap-2 pt-2 text-xs text-muted-foreground">
        <Checkbox checked={skipLanding} onCheckedChange={(v) => onToggleSkip(v === true)} />
        {t("readmeSkipLanding")}
      </label>

      <SaveRecommendPresetDialog
        pending={savePreset}
        repo={data.repo}
        onOpenChange={(open) => {
          if (!open) setSavePreset(null);
        }}
      />
    </div>
  );
}

/**
 * 推荐卡「存为预设」弹层：形态照抄 model-params-form.tsx 的 SavePresetDialog
 * （Dialog + Input + 一行 hint + 提交按钮，i18n 复用 common.paramPresets.*），
 * 差异只在请求体多带 `source: "readme"` / `sourceRepo`。已知的几处 minor
 * （缺 DialogDescription/Label、Enter 不提交、res.json() 未包 catch）原样照抄，
 * 不在这里顺手修——那是 T11 那份的事。
 *
 * 内容拆成外层（只管 open/close）+ 内层表单（拥有 name/busy state）两层：
 * `pending` 每次换成新的一套推荐时，`key={pending.name}` 让内层表单重新挂载、
 * 拿到全新的默认名——比在 effect 里 setState 同步 props 更符合 React 的建议写法
 * （react-hooks/set-state-in-effect 也会拒绝后者）。
 */
function SaveRecommendPresetDialog({
  pending,
  repo,
  onOpenChange,
}: {
  pending: { server: Partial<ServerConfig>; name: string } | null;
  repo: string;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={pending !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        {pending !== null && (
          <SaveRecommendPresetForm key={pending.name} pending={pending} repo={repo} onOpenChange={onOpenChange} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function SaveRecommendPresetForm({
  pending,
  repo,
  onOpenChange,
}: {
  pending: { server: Partial<ServerConfig>; name: string };
  repo: string;
  onOpenChange: (open: boolean) => void;
}) {
  const tc = useTranslations("common");
  const [name, setName] = useState(pending.name);
  const [busy, setBusy] = useState(false);

  const fieldCount = Object.keys(pending.server).length;

  async function onSubmit(): Promise<void> {
    if (busy || name.trim() === "" || fieldCount === 0) return;
    setBusy(true);
    const res = await apiFetch("/api/v1/presets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: name.trim(),
        server: pending.server,
        source: "readme",
        sourceRepo: repo,
      }),
    }).catch(() => null);
    setBusy(false);

    if (res === null) return void toast.error(tc("paramPresets.errorNetwork"));
    if (res.status === 409) return void toast.error(tc("paramPresets.saveConflict"));
    if (!res.ok) return void toast.error(tc("paramPresets.errorRequest"));

    onOpenChange(false);
    toast.success(tc("paramPresets.saveDone"));
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{tc("paramPresets.saveAs")}</DialogTitle>
      </DialogHeader>
      <div className="flex flex-col gap-3">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={tc("paramPresets.namePlaceholder")}
          maxLength={64}
        />
        <p className="text-xs text-muted-foreground">{tc("paramPresets.saveHint", { count: fieldCount })}</p>
      </div>
      <DialogFooter>
        <Button disabled={busy || name.trim() === "" || fieldCount === 0} onClick={() => void onSubmit()}>
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
          {tc("paramPresets.save")}
        </Button>
      </DialogFooter>
    </>
  );
}
