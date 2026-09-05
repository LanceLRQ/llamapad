// src/server/doctor.test.ts —— 全依赖注入，不碰真实环境
import { describe, expect, it } from "vitest";
import { runDoctor, type DoctorDeps } from "./doctor";

function deps(over: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    listContainers: async () => [],
    checkModelsDir: async () => ({ status: "ok" as const }),
    getPathMap: () => ({ host: "/srv/llama/models", panel: "/models" }),
    getModelsHostSource: () => "env" as const,
    gpuStatus: () => "available" as const,
    gpuDeviceCount: () => 1,
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
  it("models host 未解析 → fail，detail 给出三条解决途径且带上 panel 路径", async () => {
    const r = await runDoctor(
      deps({
        getPathMap: () => ({ host: "", panel: "/host-models" }),
        getModelsHostSource: () => "unresolved" as const,
      }),
    );
    const item = r.find((x) => x.id === "pathMap");
    expect(item?.status).toBe("fail");
    expect(item?.detail).toContain("PANEL_MODELS_HOST");
    expect(item?.detail).toContain("paths.models.host");
    expect(item?.detail).toContain("/host-models"); // panel 路径已代入 detail
  });

  it.each([
    ["env", "环境变量 PANEL_MODELS_HOST"],
    ["file", "panel.yaml 配置"],
    ["discovered", "自动发现（容器挂载表）"],
  ] as const)("host 来源为 %s → ok，detail 带来源标注与 host → panel 映射", async (source, label) => {
    const r = await runDoctor(
      deps({
        getPathMap: () => ({ host: "/srv/llama/models", panel: "/host-models" }),
        getModelsHostSource: () => source,
      }),
    );
    const item = r.find((x) => x.id === "pathMap");
    expect(item?.status).toBe("ok");
    expect(item?.detail).toContain(label);
    expect(item?.detail).toContain("/srv/llama/models");
    expect(item?.detail).toContain("/host-models");
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
  it("GPU 可用且多卡 → detail 报出卡数", async () => {
    const r = await runDoctor(deps({ gpuDeviceCount: () => 2 }));
    const item = r.find((x) => x.id === "gpu");
    expect(item?.status).toBe("ok");
    expect(item?.detail).toContain("2");
  });
  it("GPU 可用但卡数为 0（probe 过了、tick 未出数）→ 不带 detail，不谎报 0 张", async () => {
    const r = await runDoctor(deps({ gpuDeviceCount: () => 0 }));
    const item = r.find((x) => x.id === "gpu");
    expect(item?.status).toBe("ok");
    expect(item?.detail).toBeUndefined();
  });
  it("GPU 不可用时不查卡数（不可用就没有卡数这个概念）", async () => {
    let called = false;
    const r = await runDoctor(
      deps({
        gpuStatus: () => "unavailable",
        gpuDeviceCount: () => {
          called = true;
          return 1;
        },
      }),
    );
    expect(called).toBe(false);
    const item = r.find((x) => x.id === "gpu");
    expect(item?.status).toBe("warn");
    expect(item?.detail).toBe("未检测到可用 GPU（纯 CPU 部署下属正常）");
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
