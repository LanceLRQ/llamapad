import { describe, expect, it } from "vitest";

import { buildModelNameGroups, type ModelNameServiceInput, type ModelNameUpstreamInput } from "./relay-model-names";

const svc = (model: string, ready = true): ModelNameServiceInput => ({ model, displayName: model.toUpperCase(), ready });

function up(name: string, patch: Partial<ModelNameUpstreamInput> = {}): ModelNameUpstreamInput {
  return {
    name,
    displayName: name,
    enabled: true,
    state: "reachable",
    isDefault: false,
    upstreamModel: null,
    aliases: [],
    ...patch,
  };
}

describe("buildModelNameGroups", () => {
  it("托管：按输入顺序，状态取 ready，默认取托管默认", () => {
    const groups = buildModelNameGroups({
      services: [svc("a"), svc("b", false)],
      upstreams: [],
      managedDefault: "b",
    });
    expect(groups.managed.count).toBe(2);
    expect(groups.managed.rows).toEqual([
      { kind: "managed", name: "a", title: "A", status: "ready", isDefault: false, forwardsTo: null },
      { kind: "managed", name: "b", title: "B", status: "loading", isDefault: true, forwardsTo: null },
    ]);
  });

  it("外部：上游名后紧跟它的别名，数量 = 上游 + 别名", () => {
    const groups = buildModelNameGroups({
      services: [],
      upstreams: [
        up("u1", { aliases: [{ alias: "x", upstreamModel: null }, { alias: "y", upstreamModel: null }] }),
        up("u2"),
      ],
      managedDefault: null,
    });
    expect(groups.external.rows.map((r) => `${r.kind}:${r.name}`)).toEqual([
      "upstream:u1",
      "alias:x",
      "alias:y",
      "upstream:u2",
    ]);
    expect(groups.external.count).toBe(4);
  });

  it("已停用的上游及其别名不出现，也不计数", () => {
    const groups = buildModelNameGroups({
      services: [],
      upstreams: [up("off", { enabled: false, state: "disabled", aliases: [{ alias: "z", upstreamModel: null }] }), up("on")],
      managedDefault: null,
    });
    expect(groups.external.rows.map((r) => r.name)).toEqual(["on"]);
    expect(groups.external.count).toBe(1);
  });

  it("不可达的上游仍列出，状态为 unreachable（点名它仍会被路由）", () => {
    const groups = buildModelNameGroups({
      services: [],
      upstreams: [up("down", { state: "unreachable", aliases: [{ alias: "d", upstreamModel: null }] })],
      managedDefault: null,
    });
    expect(groups.external.rows.map((r) => [r.name, r.status])).toEqual([
      ["down", "unreachable"],
      ["d", "unreachable"],
    ]);
  });

  it("未探测过的上游状态为 unknown", () => {
    const groups = buildModelNameGroups({ services: [], upstreams: [up("fresh", { state: "unknown" })], managedDefault: null });
    expect(groups.external.rows[0].status).toBe("unknown");
  });

  it("别名的转发目标：自己的目标 > 上游的上游模型名 > null", () => {
    const groups = buildModelNameGroups({
      services: [],
      upstreams: [
        up("u", {
          upstreamModel: "real",
          aliases: [
            { alias: "own", upstreamModel: "special" },
            { alias: "inherit", upstreamModel: null },
          ],
        }),
        up("v", { aliases: [{ alias: "bare", upstreamModel: null }] }),
      ],
      managedDefault: null,
    });
    const by = Object.fromEntries(groups.external.rows.map((r) => [r.name, r.forwardsTo]));
    expect(by).toEqual({ u: "real", own: "special", inherit: "real", v: null, bare: null });
  });

  it("默认是可用的外部上游 → 只有它带默认标记，托管默认不再标", () => {
    const groups = buildModelNameGroups({
      services: [svc("a")],
      upstreams: [up("u", { isDefault: true, aliases: [{ alias: "al", upstreamModel: null }] })],
      managedDefault: "a",
    });
    expect(groups.managed.rows[0].isDefault).toBe(false);
    expect(groups.external.rows.find((r) => r.name === "u")?.isDefault).toBe(true);
    expect(groups.external.rows.find((r) => r.name === "al")?.isDefault).toBe(false);
  });

  it("默认上游不可达 → 降级到托管默认，标记落在托管模型上", () => {
    const groups = buildModelNameGroups({
      services: [svc("a")],
      upstreams: [up("u", { isDefault: true, state: "unreachable" })],
      managedDefault: "a",
    });
    expect(groups.managed.rows[0].isDefault).toBe(true);
    expect(groups.external.rows[0].isDefault).toBe(false);
  });

  it("默认上游不可达且没有托管模型可降级 → 仍标在上游上", () => {
    const groups = buildModelNameGroups({
      services: [],
      upstreams: [up("u", { isDefault: true, state: "unreachable" })],
      managedDefault: null,
    });
    expect(groups.external.rows[0].isDefault).toBe(true);
  });

  it("默认上游已停用 → 不作数，回到托管默认", () => {
    const groups = buildModelNameGroups({
      services: [svc("a")],
      upstreams: [up("u", { isDefault: true, enabled: false, state: "disabled" })],
      managedDefault: "a",
    });
    expect(groups.managed.rows[0].isDefault).toBe(true);
  });
});
