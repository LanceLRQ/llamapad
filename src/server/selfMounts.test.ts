import { describe, expect, it } from "vitest";
import { createMockDockerAdapter } from "./adapters/mock";
import type { ContainerMount } from "./adapters/types";
import { discoverHostModelsRoot, findBindSource, selfContainerId } from "./selfMounts";

/**
 * 造一份最小 ProcessEnv（Next 把 NODE_ENV 加成必填字段，纯字面量 `{ HOSTNAME: "x" }`
 * 过不了 tsc；测试只关心 HOSTNAME，其余字段用真实 process.env 兜底即可）。
 * 不传 hostname 时不设置该键——模拟"非容器环境"下 HOSTNAME 本就不存在的状态。
 */
function fakeEnv(hostname?: string): NodeJS.ProcessEnv {
  return { ...process.env, HOSTNAME: hostname };
}

describe("selfContainerId", () => {
  it("HOSTNAME 是 12 位小写十六进制时判定为容器 id", () => {
    expect(selfContainerId(fakeEnv("a1b2c3d4e5f6"))).toBe("a1b2c3d4e5f6");
  });

  it("HOSTNAME 缺失（非容器环境，如本机 pnpm dev）返回 null", () => {
    expect(selfContainerId(fakeEnv())).toBeNull();
  });

  it("HOSTNAME 被显式覆盖成自定义值（compose 的 hostname:）返回 null", () => {
    expect(selfContainerId(fakeEnv("my-llamapad"))).toBeNull();
  });

  it("HOSTNAME 长度不满足 12 位十六进制返回 null", () => {
    expect(selfContainerId(fakeEnv("a1b2c3d4e5f"))).toBeNull(); // 11 位
    expect(selfContainerId(fakeEnv("a1b2c3d4e5f6a"))).toBeNull(); // 13 位
    expect(selfContainerId(fakeEnv("A1B2C3D4E5F6"))).toBeNull(); // 大写不算
  });
});

describe("findBindSource", () => {
  const mounts: ContainerMount[] = [
    { type: "bind", source: "/srv/llama/models", destination: "/host-models" },
    { type: "volume", source: "some-volume", destination: "/host-models-vol" },
  ];

  it("命中 bind 类型的 destination", () => {
    expect(findBindSource(mounts, "/host-models")).toBe("/srv/llama/models");
  });

  it("非 bind 类型即使 destination 相同也跳过", () => {
    expect(findBindSource(mounts, "/host-models-vol")).toBeNull();
  });

  it("无命中返回 null", () => {
    expect(findBindSource(mounts, "/not-mounted")).toBeNull();
  });
});

describe("discoverHostModelsRoot", () => {
  it("非容器环境（HOSTNAME 取不到有效 id）直接返回 null，不查 docker", async () => {
    const adapter = createMockDockerAdapter();
    expect(await discoverHostModelsRoot(adapter, "/host-models", fakeEnv())).toBeNull();
  });

  it("自身容器查不到（inspectMounts 返回 null）返回 null", async () => {
    const adapter = createMockDockerAdapter();
    // 未注入任何挂载表 → mock 的 inspectMounts 视为容器不存在
    expect(await discoverHostModelsRoot(adapter, "/host-models", fakeEnv("a1b2c3d4e5f6"))).toBeNull();
  });

  it("挂载表里没有命中 panelPath 的 bind 返回 null", async () => {
    const adapter = createMockDockerAdapter();
    adapter.setMounts("a1b2c3d4e5f6", [{ type: "bind", source: "/data/config", destination: "/config" }]);

    expect(await discoverHostModelsRoot(adapter, "/host-models", fakeEnv("a1b2c3d4e5f6"))).toBeNull();
  });

  it("docker 不可用（inspectMounts 抛错）安静降级为 null", async () => {
    const mockAdapter = createMockDockerAdapter();
    const throwingAdapter = {
      ...mockAdapter,
      inspectMounts: async () => {
        throw new Error("connect ENOENT /var/run/docker.sock");
      },
    };

    expect(
      await discoverHostModelsRoot(throwingAdapter, "/host-models", fakeEnv("a1b2c3d4e5f6")),
    ).toBeNull();
  });

  it("命中挂载表里的 bind 时返回宿主机路径", async () => {
    const adapter = createMockDockerAdapter();
    adapter.setMounts("a1b2c3d4e5f6", [
      { type: "bind", source: "/srv/llama/models", destination: "/host-models" },
    ]);

    expect(await discoverHostModelsRoot(adapter, "/host-models", fakeEnv("a1b2c3d4e5f6"))).toBe(
      "/srv/llama/models",
    );
  });
});
