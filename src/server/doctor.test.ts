// src/server/doctor.test.ts —— 全依赖注入，不碰真实环境
import { describe, expect, it } from "vitest";
import { runDoctor, type DoctorDeps } from "./doctor";

function deps(over: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    listContainers: async () => [],
    checkModelsDir: async () => ({ status: "ok" as const }),
    getPathMap: () => ({ host: "/srv/llama/models", panel: "/models" }),
    inContainer: () => true,
    gpuStatus: () => "available" as const,
    testHf: async () => ({ ok: true, account: "anonymous" }),
    freeBytes: async () => 100 * 1024 ** 3,
    ...over,
  };
}

describe("runDoctor", () => {
  it("全健康时六项全 ok", async () => {
    const r = await runDoctor(deps());
    expect(r.map((x) => x.id)).toEqual(["docker", "modelsDir", "pathMap", "gpu", "hf", "disk"]);
    expect(r.every((x) => x.status === "ok")).toBe(true);
  });
  it("docker 不可用 → fail 且携带原因", async () => {
    const r = await runDoctor(deps({ listContainers: async () => { throw new Error("connect ENOENT /var/run/docker.sock"); } }));
    expect(r[0]).toMatchObject({ id: "docker", status: "fail" });
    expect(r[0].detail).toContain("ENOENT");
  });
  it("GPU 不可用是 warn 不是 fail（CPU 部署合法）", async () => {
    const r = await runDoctor(deps({ gpuStatus: () => "unavailable" }));
    expect(r.find((x) => x.id === "gpu")?.status).toBe("warn");
  });
  it("容器内 host==panel 判为映射可疑 warn", async () => {
    const r = await runDoctor(deps({ getPathMap: () => ({ host: "/models", panel: "/models" }) }));
    expect(r.find((x) => x.id === "pathMap")?.status).toBe("warn");
  });
  it("非容器环境 host==panel 属正常（Mac 开发）", async () => {
    const r = await runDoctor(deps({ getPathMap: () => ({ host: "/m", panel: "/m" }), inContainer: () => false }));
    expect(r.find((x) => x.id === "pathMap")?.status).toBe("ok");
  });
  it("磁盘 <1GB fail，<5GB warn", async () => {
    expect((await runDoctor(deps({ freeBytes: async () => 500 * 1024 ** 2 }))).find((x) => x.id === "disk")?.status).toBe("fail");
    expect((await runDoctor(deps({ freeBytes: async () => 3 * 1024 ** 3 }))).find((x) => x.id === "disk")?.status).toBe("warn");
  });
  it("HF 失败只 warn 且单项异常不影响其余项", async () => {
    const r = await runDoctor(deps({ testHf: async () => { throw new Error("timeout"); } }));
    expect(r.find((x) => x.id === "hf")?.status).toBe("warn");
    expect(r.find((x) => x.id === "docker")?.status).toBe("ok");
  });
});

// Mac 实测：无代理时 HF 连通性检查要等 10.5s 才失败，整个 Doctor 卡在转圈。
// Doctor 是「点一下看环境」的即时反馈，必须有单项上限。
describe("runDoctor 单项超时", () => {
  it("卡住的检查项归为 warn，不拖住其余项", async () => {
    const stuck = new Promise<never>(() => {}); // 永不 settle
    const items = await runDoctor(deps({ testHf: () => stuck }));
    const hf = items.find((x) => x.id === "hf");
    expect(hf?.status).toBe("warn");
    expect(hf?.detail).toContain("超时");
    expect(items.find((x) => x.id === "docker")?.status).toBe("ok");
    expect(items).toHaveLength(6);
  }, 10_000);
});
