import { afterEach, describe, expect, it, vi } from "vitest";
import { randomId } from "./uuid";

const V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("randomId（HTTP 局域网下 crypto.randomUUID 缺席的回退）", () => {
  it("crypto.randomUUID 存在时直接用它的返回值", () => {
    const randomUUID = vi.fn().mockReturnValue("11111111-1111-4111-8111-111111111111");
    vi.stubGlobal("crypto", { randomUUID, getRandomValues: vi.fn() });

    expect(randomId()).toBe("11111111-1111-4111-8111-111111111111");
    expect(randomUUID).toHaveBeenCalledTimes(1);
  });

  it("randomUUID 缺席、getRandomValues 可用时，产出合法 v4", () => {
    // 非安全上下文（HTTP 局域网）下 crypto.randomUUID 是 undefined，但
    // getRandomValues 不受安全上下文限制，是这里应当命中的一档
    vi.stubGlobal("crypto", {
      getRandomValues: (arr: Uint8Array) => {
        for (let i = 0; i < arr.length; i++) arr[i] = i * 7;
        return arr;
      },
    });

    const id = randomId();
    expect(id).toMatch(V4_PATTERN);
  });

  it("randomUUID 与 getRandomValues 都缺席时仍产出合法 v4（Math.random 兜底）", () => {
    vi.stubGlobal("crypto", {});

    const id = randomId();
    expect(id).toMatch(V4_PATTERN);
  });

  it("crypto 整体不存在时仍产出合法 v4", () => {
    vi.stubGlobal("crypto", undefined);

    const id = randomId();
    expect(id).toMatch(V4_PATTERN);
  });

  it("连续 1000 次不重复", () => {
    vi.stubGlobal("crypto", {});

    const ids = new Set(Array.from({ length: 1000 }, () => randomId()));
    expect(ids.size).toBe(1000);
  });
});
