import { describe, expect, it } from "vitest";
import { createMockDockerAdapter } from "./adapters/mock";
import { discoverImportableMounts, importableMounts } from "./mounts";
import type { ContainerMount } from "./adapters/types";

const mounts: ContainerMount[] = [
  { type: "bind", source: "/mnt/data/apps/llamapad/models", destination: "/host-models" },
  { type: "bind", source: "/mnt/data/apps/llamapad/data", destination: "/app/config" },
  { type: "bind", source: "/proc", destination: "/host/proc" },
  { type: "bind", source: "/var/run/docker.sock", destination: "/var/run/docker.sock" },
  { type: "bind", source: "/mnt/old-llama/models", destination: "/host-import" },
  { type: "volume", source: "somevol", destination: "/data" },
];

/**
 * models 那组刻意排在末尾（前面先放一个被排除项、一个非 bind），
 * 用来真正跑到 importableMounts 里 modelsIdx > 0 的重排分支——
 * 上面那份 fixture 里 models 本来就在第 0 位，splice 那两行永远不会执行到。
 */
const mountsModelsLast: ContainerMount[] = [
  { type: "bind", source: "/proc", destination: "/host/proc" },
  { type: "volume", source: "somevol", destination: "/data" },
  { type: "bind", source: "/mnt/old-llama/models", destination: "/host-import" },
  { type: "bind", source: "/mnt/data/apps/llamapad/models", destination: "/host-models" },
];

describe("importableMounts", () => {
  it("排除面板运行必需的三项与非 bind 挂载", () => {
    const got = importableMounts(mounts, "/host-models");
    expect(got.map((m) => m.panel)).toEqual(["/host-models", "/host-import"]);
  });

  it("models 那组恒在首位，供 UI 把它标为默认扫描范围", () => {
    expect(importableMounts(mounts, "/host-models")[0]!.host).toBe(
      "/mnt/data/apps/llamapad/models",
    );
  });

  it("models 排在挂载表末尾时也会被搬到结果首位（真正跑到重排分支）", () => {
    const got = importableMounts(mountsModelsLast, "/host-models");
    expect(got.map((m) => m.panel)).toEqual(["/host-models", "/host-import"]);
    expect(got[0]!.host).toBe("/mnt/data/apps/llamapad/models");
  });

  it("挂载表为空（非容器环境）返回空数组，不抛错", () => {
    expect(importableMounts([], "/host-models")).toEqual([]);
  });
});

/**
 * 造一份最小 ProcessEnv（Next 把 NODE_ENV 加成必填字段，纯字面量 `{ HOSTNAME: "x" }`
 * 过不了 tsc；测试只关心 HOSTNAME，其余字段用真实 process.env 兜底即可）。
 * 手法与 selfMounts.test.ts 的同名 helper 一致。
 */
function fakeEnv(hostname?: string): NodeJS.ProcessEnv {
  return { ...process.env, HOSTNAME: hostname };
}

describe("discoverImportableMounts", () => {
  it("非容器环境（HOSTNAME 取不到有效 id）直接返回空数组，不查 docker", async () => {
    const adapter = createMockDockerAdapter();
    expect(await discoverImportableMounts(adapter, "/host-models", fakeEnv())).toEqual([]);
  });

  it("自身容器查不到（inspectMounts 返回 null）返回空数组", async () => {
    const adapter = createMockDockerAdapter();
    // 未注入任何挂载表 → mock 的 inspectMounts 视为容器不存在
    expect(
      await discoverImportableMounts(adapter, "/host-models", fakeEnv("a1b2c3d4e5f6")),
    ).toEqual([]);
  });

  it("挂载表里只有面板必需挂载时返回空数组", async () => {
    const adapter = createMockDockerAdapter();
    adapter.setMounts("a1b2c3d4e5f6", [
      { type: "bind", source: "/mnt/data/apps/llamapad/data", destination: "/app/config" },
    ]);

    expect(
      await discoverImportableMounts(adapter, "/host-models", fakeEnv("a1b2c3d4e5f6")),
    ).toEqual([]);
  });

  it("docker 不可用（inspectMounts 抛错）安静降级为空数组", async () => {
    const mockAdapter = createMockDockerAdapter();
    const throwingAdapter = {
      ...mockAdapter,
      inspectMounts: async () => {
        throw new Error("connect ENOENT /var/run/docker.sock");
      },
    };

    expect(
      await discoverImportableMounts(throwingAdapter, "/host-models", fakeEnv("a1b2c3d4e5f6")),
    ).toEqual([]);
  });

  it("命中挂载表时返回筛选后的可用导入源，models 排首位", async () => {
    const adapter = createMockDockerAdapter();
    adapter.setMounts("a1b2c3d4e5f6", mounts);

    const got = await discoverImportableMounts(adapter, "/host-models", fakeEnv("a1b2c3d4e5f6"));
    expect(got).toEqual([
      { host: "/mnt/data/apps/llamapad/models", panel: "/host-models" },
      { host: "/mnt/old-llama/models", panel: "/host-import" },
    ]);
  });
});
