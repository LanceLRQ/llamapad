import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * mock undici：只替换 ProxyAgent（记录构造参数与实例，close 换成可断言的 spy），
 * 与 hf/client.test.ts 同款写法。
 */
const { ProxyAgentMock } = vi.hoisted(() => ({
  // mock 实例经由 `new ProxyAgent(...)` 构造，箭头函数不能作构造器，须用 function
  ProxyAgentMock: vi.fn().mockImplementation(function (opts: { uri: string }) {
    return { uri: opts.uri, close: vi.fn().mockResolvedValue(undefined) };
  }),
}));

vi.mock("undici", async (importOriginal) => ({
  ...(await importOriginal<typeof import("undici")>()),
  ProxyAgent: ProxyAgentMock,
}));

import { getProxyAgent, _resetProxyAgentCacheForTest } from "./proxyAgentCache";

/** mock 出来的 ProxyAgent 实例形状（真实类型没有 close 之外的可断言字段） */
interface MockAgent {
  uri: string;
  close: ReturnType<typeof vi.fn>;
}

describe("getProxyAgent（按 uri 缓存的进程级 ProxyAgent 单例）", () => {
  beforeEach(() => {
    ProxyAgentMock.mockClear();
    _resetProxyAgentCacheForTest();
  });

  it("同一 uri 连续取两次，返回同一个实例", () => {
    const a = getProxyAgent("http://127.0.0.1:7890");
    const b = getProxyAgent("http://127.0.0.1:7890");

    expect(a).toBe(b);
    expect(ProxyAgentMock).toHaveBeenCalledTimes(1);
  });

  it("不同 uri 取到不同实例", () => {
    const a = getProxyAgent("http://127.0.0.1:7890");
    const b = getProxyAgent("http://127.0.0.1:7891");

    expect(a).not.toBe(b);
    expect(ProxyAgentMock).toHaveBeenCalledTimes(2);
    expect(ProxyAgentMock).toHaveBeenNthCalledWith(1, { uri: "http://127.0.0.1:7890" });
    expect(ProxyAgentMock).toHaveBeenNthCalledWith(2, { uri: "http://127.0.0.1:7891" });
  });

  it("uri 变更后，旧实例的 close 被调用（释放连接池，避免每次改配置泄漏一个）", () => {
    const first = getProxyAgent("http://127.0.0.1:7890") as unknown as MockAgent;
    expect(first.close).not.toHaveBeenCalled();

    getProxyAgent("http://127.0.0.1:7891");
    expect(first.close).toHaveBeenCalledTimes(1);
  });

  it("回到旧 uri 视为新配置，重新创建实例并关闭上一个", () => {
    const first = getProxyAgent("http://127.0.0.1:7890") as unknown as MockAgent;
    const second = getProxyAgent("http://127.0.0.1:7891") as unknown as MockAgent;

    const third = getProxyAgent("http://127.0.0.1:7890");

    expect(third).not.toBe(first);
    expect(second.close).toHaveBeenCalledTimes(1);
    expect(ProxyAgentMock).toHaveBeenCalledTimes(3);
  });

  it("uri 为空/未配置时不创建 ProxyAgent，返回 undefined", () => {
    expect(getProxyAgent(undefined)).toBeUndefined();
    expect(getProxyAgent("")).toBeUndefined();
    expect(ProxyAgentMock).not.toHaveBeenCalled();
  });
});
