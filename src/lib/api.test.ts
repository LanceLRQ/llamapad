import { afterEach, describe, expect, it, vi } from "vitest";

import {
  apiFetch,
  buildSessionExpiredRedirect,
  isAuthExemptPath,
  sanitizeNextPath,
} from "./api";
import {
  CONNECTION_FAILURE_THRESHOLD,
  connectionStore,
  resetConnectionStoreForTest,
} from "./connection-store";

/** node 环境无 window/fetch DOM 语义：apiFetch 只测连接喂入与豁免逻辑（无 401 分支） */
describe("api.ts（UX P0 Task 2）", () => {
  afterEach(() => {
    resetConnectionStoreForTest();
    vi.unstubAllGlobals();
  });

  it("认证端点豁免 401 重定向判定（login/setup/logout 及其子路径）", () => {
    expect(isAuthExemptPath("/api/v1/auth/login")).toBe(true);
    expect(isAuthExemptPath("/api/v1/auth/login?x=1")).toBe(true);
    expect(isAuthExemptPath("/api/v1/auth/tokens/3")).toBe(false);
    expect(isAuthExemptPath("/api/v1/models/foo/start")).toBe(false);
  });

  it("buildSessionExpiredRedirect：带原路径与 expired 标记；login 自身不带 next", () => {
    expect(buildSessionExpiredRedirect("/models")).toBe("/login?expired=1&next=%2Fmodels");
    expect(buildSessionExpiredRedirect("/models?tab=x")).toBe(
      "/login?expired=1&next=%2Fmodels%3Ftab%3Dx",
    );
    expect(buildSessionExpiredRedirect("/login")).toBe("/login?expired=1");
  });

  it("sanitizeNextPath：只接受站内路径，防 open redirect", () => {
    expect(sanitizeNextPath("/models")).toBe("/models");
    expect(sanitizeNextPath("/models?tab=1")).toBe("/models?tab=1");
    expect(sanitizeNextPath(null)).toBeNull();
    expect(sanitizeNextPath("")).toBeNull();
    expect(sanitizeNextPath("https://evil.example")).toBeNull();
    expect(sanitizeNextPath("//evil.example")).toBeNull();
    expect(sanitizeNextPath("/login")).toBeNull();
    expect(sanitizeNextPath("/login?next=/x")).toBeNull();
  });

  it("apiFetch 成功往返喂 connection-store 成功信号", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await apiFetch("/api/v1/models");
    expect(res.status).toBe(200);
    expect(connectionStore.getSnapshot()).toBe("online");
  });

  it(`apiFetch 网络异常抛出并累计失败（<${CONNECTION_FAILURE_THRESHOLD} 次不判离线）`, async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(apiFetch("/api/v1/models")).rejects.toThrow("fetch failed");
    expect(connectionStore.getSnapshot()).toBe("online");
  });

  it(`apiFetch 连续 ${CONNECTION_FAILURE_THRESHOLD} 次网络异常判离线，成功即恢复`, async () => {
    const failing = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", failing);
    for (let i = 0; i < CONNECTION_FAILURE_THRESHOLD; i += 1) {
      await expect(apiFetch("/api/v1/models")).rejects.toThrow();
    }
    expect(connectionStore.getSnapshot()).toBe("offline");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200 })));
    await apiFetch("/api/v1/models");
    expect(connectionStore.getSnapshot()).toBe("online");
  });
});
