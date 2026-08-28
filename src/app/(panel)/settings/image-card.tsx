"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";

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
import { toast } from "@/components/toast-store";
import { BUILTIN_DEFAULT_CONFIG } from "@/core/config";
import type { DefaultConfig } from "@/core/schemas";
import { draftFromDocker, draftToPatch, type CustomDraft } from "@/lib/image-card-form";
import { apiFetch } from "@/lib/api";
import { CustomImageCard } from "./custom-image-card";
import { OfficialImagesCard } from "./official-images-card";
import type { ImagesResponseView, LoadErrorCode, PullEvent, PullState } from "./image-types";

/**
 * 设置页「镜像管理」区块（T6，client；消费 T5 后端 core/images.ts + /api/v1/images*，
 * 规格 docs/_internal/features/2026-08-28-文件管理与镜像管理-design.md §5.2–§5.6）：
 *
 * 本文件是编排层——持有全部状态与动作（拉取/设为启动镜像/删除/自定义字段
 * 保存），渲染层拆到 official-images-card.tsx（官方 variant 清单）与
 * custom-image-card.tsx（自定义镜像五字段 + 已拉取自定义镜像列表），纯逻辑
 * （草稿转换/时间格式化）下沉到 lib/image-card-form.ts——原因见该文件头注：
 * 埋在组件里就没法在 vitest 里测（vitest 的用例收集范围不含 .tsx）。
 *
 * - 拉取全局只允许一路在跑（带宽是真实瓶颈，避免多路镜像互相抢带宽），
 *   SSE 手动切帧沿用原实现（readSse），中止按钮断开连接即可，但如实告知
 *   Docker Engine API 没有"取消 pull"端点，daemon 端不保证真正停止（§5.5）
 * - 自定义镜像五字段走 PUT /api/v1/settings/default_config 整体替换（无局部
 *   patch 端点），读回原有 docker 段与之合并，只改这五个键
 *
 * 已知后端行为差异（未改动后端，仅在此绕过）：GET /api/v1/settings/:key 是
 * 裸 `SELECT value FROM settings`，全新安装尚未写过 default_config 行时返回
 * 404；而 repo.getDefaultConfig()（page.tsx 用来算 initialImage 的方法）对同一
 * 情况会回退到 BUILTIN_DEFAULT_CONFIG。本组件对 404 做同款回退。
 */

/** 按 SSE 帧规范（"\n\n" 分隔）解析 response.body，每帧回调一次（原样保留，不改切帧逻辑） */
async function readSse(body: ReadableStream<Uint8Array>, onEvent: (raw: string) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let sep = buffer.indexOf("\n\n");
    while (sep !== -1) {
      onEvent(buffer.slice(0, sep));
      buffer = buffer.slice(sep + 2);
      sep = buffer.indexOf("\n\n");
    }
  }
}

export function ImageCard({ initialImage }: { initialImage: string }) {
  const t = useTranslations("pages.settings.image");
  const tCommon = useTranslations("pages.settings");

  const [catalog, setCatalog] = useState<ImagesResponseView | null>(null);
  const [loadError, setLoadError] = useState<LoadErrorCode | null>(null);

  const [pull, setPull] = useState<PullState | null>(null);
  const [busyRef, setBusyRef] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{ ref: string; message: string } | null>(null);
  const [restartHint, setRestartHint] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const [fullConfig, setFullConfig] = useState<DefaultConfig | null>(null);
  const [draft, setDraft] = useState<CustomDraft | null>(null);
  const [customLoadError, setCustomLoadError] = useState<LoadErrorCode | null>(null);
  const [customDirty, setCustomDirty] = useState(false);
  const [customSaving, setCustomSaving] = useState(false);
  const [customError, setCustomError] = useState<string | null>(null);

  // 无外部依赖（不读取任何 state/props），useCallback 空依赖保证引用稳定，
  // 下方 mount effect 才能真正"只跑一次"而不是每次渲染都重新拉取
  const loadImages = useCallback(async (): Promise<void> => {
    const res = await apiFetch("/api/v1/images", { cache: "no-store" }).catch(() => null);
    if (res === null) {
      setLoadError("network");
      return;
    }
    if (!res.ok) {
      setLoadError("request");
      return;
    }
    setCatalog((await res.json()) as ImagesResponseView);
    setLoadError(null);
  }, []);

  const loadDefaultConfig = useCallback(async (): Promise<void> => {
    const res = await apiFetch("/api/v1/settings/default_config", { cache: "no-store" }).catch(() => null);
    if (res === null) {
      setCustomLoadError("network");
      return;
    }
    if (res.status === 404) {
      // 全新安装，settings 表尚无 default_config 行：与服务端 getDefaultConfig() 同款回退
      const fallback = structuredClone(BUILTIN_DEFAULT_CONFIG);
      setFullConfig(fallback);
      setDraft(draftFromDocker(fallback.docker));
      setCustomLoadError(null);
      return;
    }
    if (!res.ok) {
      setCustomLoadError("request");
      return;
    }
    const data = (await res.json()) as { value: string };
    const parsed = JSON.parse(data.value) as DefaultConfig;
    setFullConfig(parsed);
    setDraft(draftFromDocker(parsed.docker));
    setCustomLoadError(null);
  }, []);

  // 挂载即拉取：套一层 Promise.resolve().then(...) 而不是直接调用，是为了满足
  // react-hooks/set-state-in-effect——该规则要求 setState 发生在"回调"里而非
  // effect 体的同步调用链上，直接 void loadImages() 会因为它内部会 setState
  // 被判为反模式。loadImages/loadDefaultConfig 本身仍复用于动作完成后的刷新。
  useEffect(() => {
    Promise.resolve().then(() => loadImages());
    Promise.resolve().then(() => loadDefaultConfig());
  }, [loadImages, loadDefaultConfig]);

  /** 拉取/切换后顺带查一次运行状态：镜像变更对已起的容器不热更新，需要提示重启才生效 */
  async function checkRestartHint(): Promise<void> {
    const res = await apiFetch("/api/v1/runtime/status", { cache: "no-store" }).catch(() => null);
    if (!res?.ok) return;
    const status = (await res.json()) as { running: { model: string } | null };
    if (status.running !== null) setRestartHint(true);
  }

  async function startPull(ref: string): Promise<void> {
    if (pull?.phase === "pulling") return;
    // 拉取本身不改"当前生效镜像"是哪个 tag，只是让它的字节在本地更新——
    // 只有拉的正好是已生效的那个 tag（"更新"场景）才需要在完成后提示重启；
    // 拉一个不相关的 variant 时，跑着的模型压根没受影响，不该弹这条提示
    const wasCurrent = ref === catalog?.currentImage;
    const controller = new AbortController();
    setPull({ ref, snapshot: null, phase: "pulling", controller });
    setActionError(null);

    const res = await apiFetch("/api/v1/images/pull", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: ref }),
      signal: controller.signal,
    }).catch(() => null);

    if (res === null) {
      setPull((prev) =>
        prev && prev.ref === ref
          ? { ...prev, phase: controller.signal.aborted ? "aborted" : "error", message: tCommon("errorNetwork") }
          : prev,
      );
      return;
    }
    if (!res.ok || res.body === null) {
      const data = (await res.json().catch(() => null)) as { message?: string } | null;
      setPull((prev) =>
        prev && prev.ref === ref ? { ...prev, phase: "error", message: data?.message ?? tCommon("errorRequest") } : prev,
      );
      return;
    }

    try {
      await readSse(res.body, (rawEvent) => {
        const dataLine = rawEvent.split("\n").find((line) => line.startsWith("data: "));
        if (!dataLine) return; // 心跳注释帧（": ping"）等非 data 帧跳过
        const msg = JSON.parse(dataLine.slice("data: ".length)) as PullEvent;
        setPull((prev) => {
          if (!prev || prev.ref !== ref) return prev;
          if (msg.type === "progress") return { ...prev, snapshot: msg };
          if (msg.type === "error") return { ...prev, phase: "error", message: msg.message };
          return { ...prev, phase: "done" };
        });
      });
    } catch {
      setPull((prev) =>
        prev && prev.ref === ref
          ? { ...prev, phase: controller.signal.aborted ? "aborted" : "error", message: tCommon("errorNetwork") }
          : prev,
      );
      return;
    }

    await loadImages();
    if (wasCurrent) await checkRestartHint();
  }

  function abortPull(): void {
    pull?.controller.abort();
  }

  async function setAsDefaultImage(ref: string): Promise<void> {
    if (fullConfig === null || busyRef !== null) return;
    setBusyRef(ref);
    setActionError(null);
    const next: DefaultConfig = { ...fullConfig, docker: { ...fullConfig.docker, image: ref } };
    const res = await apiFetch("/api/v1/settings/default_config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: JSON.stringify(next) }),
    }).catch(() => null);
    setBusyRef(null);
    if (res === null || !res.ok) {
      const data = res ? ((await res.json().catch(() => null)) as { error?: string } | null) : null;
      setActionError({ ref, message: data?.error ?? tCommon("errorNetwork") });
      return;
    }
    setFullConfig(next);
    toast.success(t("setDefaultDone"));
    await loadImages();
    await checkRestartHint();
  }

  function requestDelete(ref: string): void {
    setActionError(null);
    setDeleteTarget(ref);
  }

  async function confirmDelete(): Promise<void> {
    if (deleteTarget === null) return;
    setDeleteBusy(true);
    const res = await apiFetch("/api/v1/images", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: deleteTarget }),
    }).catch(() => null);
    setDeleteBusy(false);
    if (res === null || !res.ok) {
      const data = res ? ((await res.json().catch(() => null)) as { message?: string } | null) : null;
      setActionError({ ref: deleteTarget, message: data?.message ?? tCommon("errorNetwork") });
      setDeleteTarget(null);
      return;
    }
    toast.success(t("deleteDone"));
    setDeleteTarget(null);
    await loadImages();
  }

  function updateDraft(patch: Partial<CustomDraft>): void {
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
    setCustomDirty(true);
    setCustomError(null);
  }

  async function saveCustom(): Promise<void> {
    if (draft === null || fullConfig === null || customSaving) return;
    setCustomSaving(true);
    setCustomError(null);
    const patch = draftToPatch(draft);
    const next: DefaultConfig = { ...fullConfig, docker: { ...fullConfig.docker, ...patch } };
    const res = await apiFetch("/api/v1/settings/default_config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: JSON.stringify(next) }),
    }).catch(() => null);
    setCustomSaving(false);
    if (res === null || !res.ok) {
      const data = res ? ((await res.json().catch(() => null)) as { error?: string } | null) : null;
      setCustomError(data?.error ?? tCommon("errorNetwork"));
      return;
    }
    setFullConfig(next);
    setDraft(draftFromDocker(next.docker));
    setCustomDirty(false);
    toast.success(t("customSaveDone"));
  }

  const anyPulling = pull?.phase === "pulling";

  return (
    <>
      <OfficialImagesCard
        initialImage={initialImage}
        catalog={catalog}
        loadError={loadError}
        pull={pull}
        busyRef={busyRef}
        actionError={actionError}
        restartHint={restartHint}
        startPull={startPull}
        setAsDefaultImage={setAsDefaultImage}
        requestDelete={requestDelete}
        abortPull={abortPull}
      />

      <CustomImageCard
        catalog={catalog}
        draft={draft}
        customLoadError={customLoadError}
        customDirty={customDirty}
        customSaving={customSaving}
        customError={customError}
        anyPulling={anyPulling}
        busyRef={busyRef}
        actionError={actionError}
        updateDraft={updateDraft}
        saveCustom={saveCustom}
        setAsDefaultImage={setAsDefaultImage}
        requestDelete={requestDelete}
      />

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !deleteBusy) setDeleteTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("deleteConfirmTitle")}</DialogTitle>
            <DialogDescription>
              <span className="break-all font-mono text-xs">{deleteTarget}</span>
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">{t("deleteConfirmDescription")}</p>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={deleteBusy} />}>{tCommon("cancel")}</DialogClose>
            <Button variant="destructive" disabled={deleteBusy} onClick={() => void confirmDelete()}>
              {deleteBusy && <Loader2 className="animate-spin" />}
              {deleteBusy ? t("deleting") : t("deleteConfirmButton")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
