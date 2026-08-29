import { describe, expect, it, vi } from "vitest";
import { createReadinessProbe, type FetchLike } from "./readiness";

/**
 * 就绪探测测试（真机缺陷修复：容器起来 ≠ llama-server 已监听，见 readiness.ts 头注释）
 *
 * 覆盖：200/非 200/抛错三种探测结果、TTL 内命中缓存不重复 fetch、TTL 过后
 * 重新探测、不同 hostPort 各自独立缓存、并发调用只发一次请求（惊群防护）。
 * fetch 与 now 均注入，不打真实网络也不依赖真实时钟。
 */

function textResponse(status: number): Response {
  return new Response(null, { status });
}

describe("createReadinessProbe", () => {
  it("/health 返回 200 → true", async () => {
    const fetchMock: FetchLike = vi.fn(async () => textResponse(200));
    const probe = createReadinessProbe({ fetch: fetchMock });

    expect(await probe.isReady(18080)).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:18080/health",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("/health 返回非 200 → false", async () => {
    const fetchMock: FetchLike = vi.fn(async () => textResponse(500));
    const probe = createReadinessProbe({ fetch: fetchMock });

    expect(await probe.isReady(18080)).toBe(false);
  });

  it("fetch 抛错（连接拒绝/超时）→ false，不向外抛异常", async () => {
    const fetchMock: FetchLike = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const probe = createReadinessProbe({ fetch: fetchMock });

    await expect(probe.isReady(18080)).resolves.toBe(false);
  });

  it("TTL 内命中缓存：同一 hostPort 第二次调用不重复 fetch", async () => {
    const fetchMock: FetchLike = vi.fn(async () => textResponse(200));
    let now = 0;
    const probe = createReadinessProbe({ fetch: fetchMock, now: () => now });

    expect(await probe.isReady(18080)).toBe(true);
    now += 1_999; // 未到 2000ms TTL
    expect(await probe.isReady(18080)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("TTL 过后重新 fetch：结果变化也能被看到", async () => {
    let status = 200;
    const fetchMock: FetchLike = vi.fn(async () => textResponse(status));
    let now = 0;
    const probe = createReadinessProbe({ fetch: fetchMock, now: () => now });

    expect(await probe.isReady(18080)).toBe(true);
    now += 2_000; // TTL 到期
    status = 500; // 模拟容器中途挂掉
    expect(await probe.isReady(18080)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("不同 hostPort 各自独立缓存，互不影响", async () => {
    const fetchMock: FetchLike = vi.fn(async (url) =>
      textResponse(url.includes(":18080") ? 200 : 500),
    );
    const probe = createReadinessProbe({ fetch: fetchMock });

    expect(await probe.isReady(18080)).toBe(true);
    expect(await probe.isReady(18081)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("并发调用同一 hostPort 只发一次请求（进行中的 promise 也存入缓存，防惊群）", async () => {
    let resolveFetch!: (res: Response) => void;
    const fetchMock: FetchLike = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const probe = createReadinessProbe({ fetch: fetchMock });

    const first = probe.isReady(18080);
    const second = probe.isReady(18080);
    resolveFetch(textResponse(200));

    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
