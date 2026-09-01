"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
import { CurrentImageCard } from "./current-image-card";
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

  // 读数卡的草稿：首屏取服务端渲染传下来的 initialImage（不闪空），
  // loadDefaultConfig 到位后再以它为准重新播种（见下方两处 setImageDraft）
  const [imageDraft, setImageDraft] = useState(initialImage);
  const [imageSaving, setImageSaving] = useState(false);
  // 读数卡自己的错误：不再从 actionError 按 ref 反查——草稿恰好等于某个列表行的
  // ref 时会重复展示，反过来删除失败也会串到这张卡上
  const [imageError, setImageError] = useState<string | null>(null);
  // 用 ref 而非 state：loadDefaultConfig 是空依赖的稳定 useCallback（保证 mount
  // effect 只跑一次），若改用 state 会在它创建时就把值闭包死，读到的永远是首次
  // 渲染那一刻的 false，追不上后续的按键
  const imageDraftTouchedRef = useRef(false);

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
      // 用户可能在这次请求返回前已经动过读数卡的输入框，此时不能用服务端值
      // 覆盖掉正在输入的草稿
      if (!imageDraftTouchedRef.current) setImageDraft(fallback.docker.image);
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
    if (!imageDraftTouchedRef.current) setImageDraft(parsed.docker.image);
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

  /**
   * 「当前启动镜像」（default_config.docker.image）的唯一写入路径：官方/自定义两张
   * 列表里的「设为启动镜像」按钮，与读数卡输入框的保存，都走这里。两处写的是同一个
   * 键，分开实现必然漂移。调用方只负责各自的忙碌态（列表用 busyRef、读数卡用自己的
   * saving 标志），写入、错误处理、成功后的刷新与重启提示全在这一处。
   *
   * 失败信息交给调用方指定的 onError 落地——列表按钮落在 actionError（按 ref 行内
   * 展示），读数卡落在自己的 imageError，两者共用一个 state 会互相串扰。fullConfig
   * 尚未到位（default_config 首拉还没回来）也算失败，同样要通知调用方，否则读数卡
   * 会转一圈又悄悄回到禁用态、什么都没发生。
   */
  async function writeImage(ref: string, onError: (message: string) => void): Promise<void> {
    if (fullConfig === null) {
      onError(tCommon("errorRequest"));
      return;
    }
    const next: DefaultConfig = { ...fullConfig, docker: { ...fullConfig.docker, image: ref } };
    const res = await apiFetch("/api/v1/settings/default_config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: JSON.stringify(next) }),
    }).catch(() => null);
    if (res === null || !res.ok) {
      const data = res ? ((await res.json().catch(() => null)) as { error?: string } | null) : null;
      onError(data?.error ?? tCommon("errorNetwork"));
      return;
    }
    setFullConfig(next);
    // 规格 §4.1 其一：草稿统一在这里重置，无论调用方是列表按钮还是输入框自己。
    // 漏了这步，点完列表的「设为启动镜像」输入框会停在旧值上，下一次点「保存」
    // 就把刚设好的值又改回去了；同时清掉「已被用户动过」标记，回到跟随服务端值的状态。
    // 成功写入时清空读数卡的错误状态，避免上一次失败的提示与本次成功的 toast 自相矛盾
    setImageDraft(ref);
    imageDraftTouchedRef.current = false;
    setImageError(null);
    toast.success(t("setDefaultDone"));
    await loadImages();
    await checkRestartHint();
  }

  async function setAsDefaultImage(ref: string): Promise<void> {
    // 与读数卡的保存共用 writeImage/fullConfig 同一份快照，互不设防会并发两路
    // PUT、最终值取决于哪个响应先回，因此两个忙碌态要互相设防
    if (busyRef !== null || imageSaving) return;
    setBusyRef(ref);
    setActionError(null);
    await writeImage(ref, (message) => setActionError({ ref, message }));
    setBusyRef(null);
  }

  async function saveCurrentImage(): Promise<void> {
    if (imageSaving || busyRef !== null) return;
    setImageSaving(true);
    setImageError(null);
    await writeImage(imageDraft.trim(), setImageError);
    setImageSaving(false);
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

  function handleImageDraftChange(value: string): void {
    imageDraftTouchedRef.current = true;
    setImageDraft(value);
  }

  const anyPulling = pull?.phase === "pulling";

  return (
    <>
      <CurrentImageCard
        draft={imageDraft}
        saved={fullConfig?.docker.image ?? initialImage}
        catalog={catalog}
        saving={imageSaving}
        error={imageError}
        onDraftChange={handleImageDraftChange}
        onSave={() => void saveCurrentImage()}
      />

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
          {/* A 级：删除后需重新拉取，破坏性后果，不做灰色小字 */}
          <p className="text-sm text-foreground">{t("deleteConfirmDescription")}</p>
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
