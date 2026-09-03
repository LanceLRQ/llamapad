import { describe, expect, it } from "vitest";
import { importableMounts } from "./mounts";
import type { ContainerMount } from "./adapters/types";

const mounts: ContainerMount[] = [
  { type: "bind", source: "/mnt/data/apps/llamapad/models", destination: "/host-models" },
  { type: "bind", source: "/mnt/data/apps/llamapad/data", destination: "/app/config" },
  { type: "bind", source: "/proc", destination: "/host/proc" },
  { type: "bind", source: "/var/run/docker.sock", destination: "/var/run/docker.sock" },
  { type: "bind", source: "/mnt/old-llama/models", destination: "/host-import" },
  { type: "volume", source: "somevol", destination: "/data" },
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

  it("挂载表为空（非容器环境）返回空数组，不抛错", () => {
    expect(importableMounts([], "/host-models")).toEqual([]);
  });
});
