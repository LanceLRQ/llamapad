import { describe, expect, it } from "vitest";
import { decideRelayRoute, resolveRelayDefault, type RelayRouteInput } from "./relay-route";

const base: RelayRouteInput = {
  requested: null,
  running: ["a", "b"],
  managedDefault: "a",
  isConfiguredModel: (name) => ["a", "b", "stopped"].includes(name),
  upstreams: [],
  defaultUpstream: null,
};

const strata = { name: "strata", enabled: true, routable: true };

describe("decideRelayRoute：点名", () => {
  it("运行中的托管模型 → 发往它", () => {
    expect(decideRelayRoute({ ...base, requested: "b" })).toEqual({
      kind: "route",
      target: { kind: "managed", name: "b" },
      via: "requested",
      activate: null,
    });
  });

  it("启用的外部上游 → 发往它，不可达也照发", () => {
    for (const routable of [true, false]) {
      expect(decideRelayRoute({ ...base, requested: "strata", upstreams: [{ ...strata, routable }] })).toEqual({
        kind: "route",
        target: { kind: "external", name: "strata" },
        via: "requested",
        activate: null,
      });
    }
  });

  it("配置过但没在跑的托管模型 → not-running", () => {
    expect(decideRelayRoute({ ...base, requested: "stopped" })).toEqual({ kind: "not-running", model: "stopped" });
  });

  it("已停用的外部上游 → upstream-disabled", () => {
    expect(
      decideRelayRoute({ ...base, requested: "strata", upstreams: [{ ...strata, enabled: false }] }),
    ).toEqual({ kind: "upstream-disabled", upstream: "strata" });
  });

  it("不认识的名字 → 回落默认", () => {
    expect(decideRelayRoute({ ...base, requested: "gpt-4o" })).toEqual({
      kind: "route",
      target: { kind: "managed", name: "a" },
      via: "fallback-default",
      activate: null,
    });
  });
});

describe("decideRelayRoute：默认", () => {
  it("没有默认上游 → 现有规则", () => {
    expect(decideRelayRoute(base)).toEqual({
      kind: "route",
      target: { kind: "managed", name: "a" },
      via: "default",
      activate: null,
    });
  });

  it("默认上游启用且可达 → 发往它，托管模型在跑也不抢", () => {
    expect(decideRelayRoute({ ...base, upstreams: [strata], defaultUpstream: "strata" })).toEqual({
      kind: "route",
      target: { kind: "external", name: "strata" },
      via: "default",
      activate: null,
    });
  });

  it("默认上游不可达且有托管模型 → 降级，并要求激活探测", () => {
    const input = { ...base, upstreams: [{ ...strata, routable: false }], defaultUpstream: "strata" };
    expect(decideRelayRoute(input)).toEqual({
      kind: "route",
      target: { kind: "managed", name: "a" },
      via: "fallback-unreachable",
      activate: "strata",
    });
    expect(decideRelayRoute({ ...input, requested: "gpt-4o" })).toMatchObject({
      via: "fallback-unreachable",
      activate: "strata",
    });
  });

  it("默认上游不可达且没有托管模型 → 仍发往它", () => {
    expect(
      decideRelayRoute({
        ...base,
        running: [],
        managedDefault: null,
        upstreams: [{ ...strata, routable: false }],
        defaultUpstream: "strata",
      }),
    ).toEqual({ kind: "route", target: { kind: "external", name: "strata" }, via: "default", activate: null });
  });

  it("默认上游已停用 → 当作没设置", () => {
    expect(
      decideRelayRoute({ ...base, upstreams: [{ ...strata, enabled: false }], defaultUpstream: "strata" }),
    ).toMatchObject({ target: { kind: "managed", name: "a" }, via: "default", activate: null });
  });

  it("什么都没有 → no-model；有启用的上游但没设为默认也是 no-model", () => {
    const empty = { ...base, running: [], managedDefault: null };
    expect(decideRelayRoute(empty)).toEqual({ kind: "no-model" });
    expect(decideRelayRoute({ ...empty, upstreams: [strata] })).toEqual({ kind: "no-model" });
  });
});

describe("resolveRelayDefault", () => {
  it("给出生效的默认目标与是否处于降级", () => {
    expect(resolveRelayDefault({ ...base, upstreams: [strata], defaultUpstream: "strata" })).toEqual({
      target: { kind: "external", name: "strata" },
      degradedFrom: null,
    });
    expect(
      resolveRelayDefault({ ...base, upstreams: [{ ...strata, routable: false }], defaultUpstream: "strata" }),
    ).toEqual({ target: { kind: "managed", name: "a" }, degradedFrom: "strata" });
    expect(resolveRelayDefault({ ...base, running: [], managedDefault: null })).toEqual({
      target: null,
      degradedFrom: null,
    });
  });
});
