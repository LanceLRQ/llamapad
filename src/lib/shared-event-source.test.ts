import { describe, expect, it, vi } from "vitest";

import { createStreamRegistry, type StreamSourceLike } from "./shared-event-source";

/** 假 source：手动派发 open/error/message，记录 close */
function fakeSource() {
  const source = {
    onmessage: null,
    onopen: null,
    onerror: null,
    close: vi.fn(),
  } as unknown as { onmessage: unknown; onopen: unknown; onerror: unknown; close: ReturnType<typeof vi.fn> };
  return source as StreamSourceLike & { close: ReturnType<typeof vi.fn> };
}

function emit(source: StreamSourceLike, kind: "open" | "error", ): void {
  if (kind === "open") (source.onopen as () => void)();
  else (source.onerror as () => void)();
}

describe("shared-event-source（UX P0 走查修复）", () => {
  it("同端点多订阅者只开一条连接，消息全量扇出", () => {
    const source = fakeSource();
    const open = vi.fn(() => source);
    const registry = createStreamRegistry(open);

    const a = vi.fn();
    const b = vi.fn();
    const unA = registry.subscribe("/s", { onData: a });
    const unB = registry.subscribe("/s", { onData: b });
    expect(open).toHaveBeenCalledTimes(1);

    (source.onmessage as (e: { data: string }) => void)({ data: "frame-1" });
    expect(a).toHaveBeenCalledWith("frame-1");
    expect(b).toHaveBeenCalledWith("frame-1");
    unA();
    unB();
  });

  it("订阅计数归零关连接；再订阅重开", () => {
    const source = fakeSource();
    const open = vi.fn(() => source);
    const registry = createStreamRegistry(open);

    const un = registry.subscribe("/s", { onData: () => {} });
    un();
    expect(source.close).toHaveBeenCalledTimes(1);
    expect(registry.activeCount()).toBe(0);

    registry.subscribe("/s", { onData: () => {} });
    expect(open).toHaveBeenCalledTimes(2);
    expect(registry.activeCount()).toBe(1);
  });

  it("部分退订不关连接（仍有订阅者时）", () => {
    const source = fakeSource();
    const registry = createStreamRegistry(() => source);
    const unA = registry.subscribe("/s", { onData: () => {} });
    const unB = registry.subscribe("/s", { onData: () => {} });
    unA();
    expect(source.close).not.toHaveBeenCalled();
    expect(registry.activeCount()).toBe(1);
    unB();
    expect(source.close).toHaveBeenCalledTimes(1);
  });

  it("连接状态迁移通知全体订阅者；晚注册者回放当前态", () => {
    const source = fakeSource();
    const registry = createStreamRegistry(() => source);
    const statesA: boolean[] = [];
    const statesB: boolean[] = [];
    registry.subscribe("/s", { onData: () => {}, onStateChange: (c) => statesA.push(c) });
    // 注册即回放初始态（未连接）
    expect(statesA).toEqual([false]);
    emit(source, "open");
    expect(statesA).toEqual([false, true]);
    // 晚注册者注册即收到当前态 true
    registry.subscribe("/s", { onData: () => {}, onStateChange: (c) => statesB.push(c) });
    expect(statesB).toEqual([true]);
    emit(source, "error");
    expect(statesA).toEqual([false, true, false]);
    expect(statesB).toEqual([true, false]);
    // 重复同态不重复通知
    emit(source, "error");
    expect(statesA).toEqual([false, true, false]);
  });

  it("不同端点各持一条连接", () => {
    const open = vi.fn((_url: string) => fakeSource());
    const registry = createStreamRegistry(open);
    registry.subscribe("/a", { onData: () => {} });
    registry.subscribe("/b", { onData: () => {} });
    expect(registry.activeCount()).toBe(2);
  });
});
