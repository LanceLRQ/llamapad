import { describe, expect, it } from "vitest";
import { INITIAL_HEALTH } from "../../lib/upstream-health";
import type { StoredUpstream } from "../repo/upstreams";
import { toUpstreamView } from "./view";

const stored: StoredUpstream = {
  name: "strata",
  displayName: "Strata",
  baseUrl: "http://up:8080",
  apiKey: "sk-secret-9f3a",
  upstreamModel: null,
  enabled: true,
  note: null,
  aliases: [],
  createdAt: Date.parse("2026-10-11T00:00:00.000Z"),
  updatedAt: Date.parse("2026-10-11T01:00:00.000Z"),
};

describe("toUpstreamView", () => {
  it("不带出密钥明文，只给尾 4 位", () => {
    const view = toUpstreamView(stored, INITIAL_HEALTH, "strata");
    expect(JSON.stringify(view)).not.toContain("sk-secret");
    expect(view).toMatchObject({
      hasApiKey: true,
      apiKeyTail: "9f3a",
      state: "unknown",
      isDefault: true,
      lastCheckedAt: null,
      createdAt: "2026-10-11T00:00:00.000Z",
      updatedAt: "2026-10-11T01:00:00.000Z",
    });
  });

  it("已停用 → state 固定为 disabled，忽略残留的存活状态", () => {
    const view = toUpstreamView(
      { ...stored, enabled: false, apiKey: null },
      { ...INITIAL_HEALTH, state: "reachable", lastCheckedAt: 1000 },
      null,
    );
    expect(view).toMatchObject({ state: "disabled", hasApiKey: false, apiKeyTail: null, isDefault: false });
  });
});
