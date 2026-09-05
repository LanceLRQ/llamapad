import { existsSync } from "node:fs";
import { statfs, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { runDoctor, type DoctorDeps, type ModelsDirCheckResult } from "@/server/doctor";
import { resolveHfOptions } from "@/server/hf/client";
import { testHfConnection } from "@/server/hf/verify";
import { getMetricsCollector, getPanelModelsRoot, getSharedDockerAdapter } from "@/server/locators";
import { getPathMaps } from "@/server/pathMaps";
import { getModelsHostSource } from "@/server/panelConfig";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/doctor（UX P1 U18）：环境自检六项（docker/modelsDir/pathMap/gpu/hf/disk），
 * 真实依赖装配见 buildRealDeps；判定逻辑全在 server/doctor.ts（纯依赖注入，已单测覆盖）。
 *
 * 响应：`{ items: DoctorItem[] }`，顺序固定，供前端六行卡片稳定渲染。
 */
export async function GET(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const items = await runDoctor(buildRealDeps());
  return NextResponse.json({ items });
}

/**
 * models 目录可写性探测：写一个 `.llamapad-write-test` 空文件再 unlink（现有代码没有
 * 可写性探测手段，本处新写）。EACCES/EPERM 的文案口径与 downloader.ts 的
 * fsErrorMessage 保持一致（面板容器以非 root 用户运行的权限引导），
 * 但不复用其实现——那是下载失败路径的错误分类器，语义上是"写入失败后归因"，
 * 这里是"写入前主动探测"，两者触发时机不同，硬凑复用反而增加耦合。
 */
async function checkModelsDirReal(modelsRoot: string): Promise<ModelsDirCheckResult> {
  if (!existsSync(modelsRoot)) {
    return { status: "fail", detail: `models 目录不存在: ${modelsRoot}` };
  }
  const probePath = path.join(modelsRoot, ".llamapad-write-test");
  try {
    await writeFile(probePath, "");
    await unlink(probePath);
    return { status: "ok" };
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "EACCES" || err.code === "EPERM") {
      return {
        status: "fail",
        detail: `models 目录不可写: ${err.message}（面板容器以非 root 用户运行，请确认该目录对面板容器的运行用户可写，参见部署文档的权限配置章节）`,
      };
    }
    return { status: "fail", detail: `models 目录不可写: ${err.message}` };
  }
}

/**
 * 真实依赖装配：
 * - listContainers 用 getSharedDockerAdapter（非模块级 getDockerAdapter）——
 *   dev 下 Next 把各 route 编译成独立 bundle，模块级单例互不共享，见
 *   locators.ts 与 logs/stream/route.ts 的同款注释
 * - freeBytes 算法与 downloader.ts:155-168 的 checkDiskSpace 一致
 *   （statfs().bavail * bsize）；注意这与 /api/v1/disk 的"models 树占用"是
 *   两个数——disk 检查项要的是分区剩余空间，不能用错
 */
function buildRealDeps(): DoctorDeps {
  const modelsRoot = getPanelModelsRoot();
  return {
    listContainers: () => getSharedDockerAdapter().list(),
    checkModelsDir: () => checkModelsDirReal(modelsRoot),
    getPathMap: () => getPathMaps()[0],
    getModelsHostSource: () => getModelsHostSource(),
    gpuStatus: () => getMetricsCollector().nvidiaStatus(),
    gpuDeviceCount: () => getMetricsCollector().nvidiaDevices().length,
    testHf: async () => testHfConnection(await resolveHfOptions()),
    freeBytes: async () => {
      const fsStat = await statfs(modelsRoot);
      return fsStat.bavail * fsStat.bsize;
    },
  };
}
