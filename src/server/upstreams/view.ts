import type { UpstreamHealth } from "../../lib/upstream-health";
import type { UpstreamView } from "../../lib/upstream-types";
import { keyTail } from "../../lib/upstream-url";
import type { StoredUpstream } from "../repo/upstreams";

/** 仓储行 → 对外视图。密钥明文在这里止步 */
export function toUpstreamView(
  stored: StoredUpstream,
  health: UpstreamHealth,
  defaultUpstream: string | null,
): UpstreamView {
  return {
    name: stored.name,
    displayName: stored.displayName,
    baseUrl: stored.baseUrl,
    hasApiKey: stored.apiKey !== null,
    apiKeyTail: keyTail(stored.apiKey),
    upstreamModel: stored.upstreamModel,
    enabled: stored.enabled,
    note: stored.note,
    state: stored.enabled ? health.state : "disabled",
    lastCheckedAt: health.lastCheckedAt !== null ? new Date(health.lastCheckedAt).toISOString() : null,
    lastError: health.lastError,
    isDefault: defaultUpstream === stored.name,
    createdAt: new Date(stored.createdAt).toISOString(),
    updatedAt: new Date(stored.updatedAt).toISOString(),
  };
}
