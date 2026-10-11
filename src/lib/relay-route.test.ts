import { describe, expect, it } from "vitest";
import { decideRelayRoute, externalModelNames, resolveRelayDefault, type RelayRouteInput } from "./relay-route";

const base: RelayRouteInput = {
  requested: null,
  running: ["a", "b"],
  managedDefault: "a",
  isConfiguredModel: (name) => ["a", "b", "stopped"].includes(name),
  upstreams: [],
  defaultUpstream: null,
};

const strata = { name: "strata", enabled: true, routable: true, upstreamModel: null, aliases: [] };

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
        target: { kind: "external", name: "strata", forwardModel: null },
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
      target: { kind: "external", name: "strata", forwardModel: null },
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
    ).toEqual({ kind: "route", target: { kind: "external", name: "strata", forwardModel: null }, via: "default", activate: null });
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
      target: { kind: "external", name: "strata", forwardModel: null },
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

describe("decideRelayRoute：别名", () => {
  const aliased = {
    ...strata,
    upstreamModel: "base-model",
    aliases: [
      { alias: "gpt-4.1", upstreamModel: "target-a" },
      { alias: "gpt-4.1-mini", upstreamModel: "target-a" },
      { alias: "Qwen-Flash", upstreamModel: null },
    ],
  };
  const bare = { ...strata, aliases: [{ alias: "x", upstreamModel: null }] };

  it("点名别名 → 发往所属上游，forwardModel 取别名自己的目标", () => {
    expect(decideRelayRoute({ ...base, requested: "gpt-4.1", upstreams: [aliased] })).toEqual({
      kind: "route",
      target: { kind: "external", name: "strata", forwardModel: "target-a" },
      via: "requested",
      activate: null,
    });
  });

  it("两个别名指向同一个目标都能命中", () => {
    for (const requested of ["gpt-4.1", "gpt-4.1-mini"]) {
      expect(decideRelayRoute({ ...base, requested, upstreams: [aliased] })).toMatchObject({
        target: { kind: "external", name: "strata", forwardModel: "target-a" },
      });
    }
  });

  it("别名无目标 → 取上游的 upstreamModel；都没有 → null", () => {
    expect(decideRelayRoute({ ...base, requested: "Qwen-Flash", upstreams: [aliased] })).toMatchObject({
      target: { forwardModel: "base-model" },
    });
    expect(decideRelayRoute({ ...base, requested: "x", upstreams: [bare] })).toMatchObject({
      target: { kind: "external", forwardModel: null },
    });
  });

  it("所属上游已停用 → upstream-disabled，带上游名称", () => {
    expect(decideRelayRoute({ ...base, requested: "gpt-4.1", upstreams: [{ ...aliased, enabled: false }] })).toEqual({
      kind: "upstream-disabled",
      upstream: "strata",
    });
  });

  it("所属上游不可达也照发", () => {
    expect(decideRelayRoute({ ...base, requested: "gpt-4.1", upstreams: [{ ...aliased, routable: false }] })).toMatchObject({
      kind: "route",
      target: { kind: "external", name: "strata", forwardModel: "target-a" },
      via: "requested",
      activate: null,
    });
  });

  it("点名上游名称与走默认时 forwardModel 取上游自己的", () => {
    expect(decideRelayRoute({ ...base, requested: "strata", upstreams: [aliased] })).toMatchObject({
      target: { kind: "external", name: "strata", forwardModel: "base-model" },
    });
    expect(decideRelayRoute({ ...base, upstreams: [aliased], defaultUpstream: "strata" })).toMatchObject({
      target: { kind: "external", name: "strata", forwardModel: "base-model" },
      via: "default",
    });
    expect(
      decideRelayRoute({
        ...base,
        running: [],
        managedDefault: null,
        upstreams: [{ ...aliased, routable: false }],
        defaultUpstream: "strata",
      }),
    ).toMatchObject({ target: { forwardModel: "base-model" } });
  });

  it("大小写不匹配 → 不命中，回落默认", () => {
    expect(decideRelayRoute({ ...base, requested: "qwen-flash", upstreams: [aliased] })).toMatchObject({
      target: { kind: "managed", name: "a" },
      via: "fallback-default",
    });
    expect(decideRelayRoute({ ...base, requested: "qwen-flash", running: [], managedDefault: null, upstreams: [aliased] })).toEqual({
      kind: "no-model",
    });
  });

  it("配置过但没在跑的托管模型排在别名之后；别名不参与默认决议", () => {
    expect(resolveRelayDefault({ ...base, running: [], managedDefault: null, upstreams: [aliased], defaultUpstream: "gpt-4.1" })).toEqual({
      target: null,
      degradedFrom: null,
    });
  });
});

describe("externalModelNames", () => {
  it("启用且可用的上游：自己的名字之后紧跟全部别名，按存储顺序", () => {
    const a = { ...strata, name: "a", aliases: [{ alias: "z1", upstreamModel: null }, { alias: "a1", upstreamModel: "t" }] };
    const b = { ...strata, name: "b", aliases: [{ alias: "b1", upstreamModel: null }] };
    expect(externalModelNames([a, b])).toEqual(["a", "z1", "a1", "b", "b1"]);
  });

  it("停用或不可达的上游连同别名都不列出", () => {
    const aliases = [{ alias: "al", upstreamModel: null }];
    expect(externalModelNames([{ ...strata, enabled: false, aliases }])).toEqual([]);
    expect(externalModelNames([{ ...strata, routable: false, aliases }])).toEqual([]);
    expect(externalModelNames([strata])).toEqual(["strata"]);
  });
});
