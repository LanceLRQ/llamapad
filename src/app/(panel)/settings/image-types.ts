/**
 * 设置页「镜像管理」区块的共享类型（T6 返工：拆分组件后，官方 variant 列表分到
 * official-images-card.tsx、自定义镜像分到 custom-image-card.tsx，两者与持有全部
 * 状态的 image-card.tsx 都要用到同一套「GET /api/v1/images 响应形状」与「拉取
 * 进度状态」。独立成不含运行时逻辑的纯类型文件，避免组件互相 import 造成循环依赖。
 */

import type { PullSnapshot } from "@/core/pull-progress";

// ---- 与 GET /api/v1/images 响应同构的类型（客户端不引 server 模块）----
export interface ImageVariantView {
  tag: string;
  platform: string;
  ref: string;
  recommended: boolean;
  status: "current" | "local" | "not_pulled";
  local?: { id: string; size: number; created: string };
}

export interface LocalImageView {
  id: string;
  tags: string[];
  size: number;
  created: string;
}

export interface ImagesResponseView {
  registry: string;
  currentImage: string;
  recommendedTag: string;
  variants: ImageVariantView[];
  localImages: LocalImageView[];
}

export type LoadErrorCode = "network" | "request";

export type PullPhase = "pulling" | "done" | "error" | "aborted";

export interface PullState {
  ref: string;
  snapshot: PullSnapshot | null;
  phase: PullPhase;
  message?: string;
  controller: AbortController;
}

export type PullEvent =
  | ({ type: "progress" } & PullSnapshot)
  | { type: "done" }
  | { type: "error"; message: string };
