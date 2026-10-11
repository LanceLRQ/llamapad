import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FAILURE_THRESHOLD, PROBE_INTERVAL_MS } from "../../lib/upstream-health";
import { createUpstreamMonitor, probeUpstream, type MonitorTarget } from "./monitor";

const target: MonitorTarget = { name: "strata", baseUrl: "http://up:8080", apiKey: "sk-1" };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  // 只伪造定时探测用到的 interval 与 Date：Response 读 body 依赖真实的 setImmediate / setTimeout
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("probeUpstream", () => {
  it("请求 /v1/models 并带上密钥，解析出模型 id", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { data: [{ id: "a" }, { id: "b" }, { nope: 1 }] }));
    const result = await probeUpstream(target, fetchMock);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://up:8080/v1/models");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer sk-1");
    expect(result).toMatchObject({ ok: true, status: 200, models: ["a", "b"], error: null });
  });

  it("密钥含非法请求头字符 → ok:false，不抛、不发请求", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { data: [] }));
    const result = await probeUpstream({ ...target, apiKey: "a\nb" }, fetchMock);
    expect(result).toMatchObject({ ok: false, status: null });
    expect(result.error).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("没有密钥就不带 Authorization", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { data: [] }));
    await probeUpstream({ ...target, apiKey: null }, fetchMock);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).has("authorization")).toBe(false);
  });

  it("上游回 401 仍算在线（ok: true），模型列表为空", async () => {
    const result = await probeUpstream(target, async () => jsonResponse(401, { error: "bad key" }));
    expect(result).toMatchObject({ ok: true, status: 401, models: [] });
  });

  it("网络层失败 → ok: false 并带原因", async () => {
    const result = await probeUpstream(target, async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(result).toMatchObject({ ok: false, status: null, models: [], error: "ECONNREFUSED" });
  });
});

describe("createUpstreamMonitor", () => {
  function setup(responder: () => Promise<Response>) {
    const fetchMock = vi.fn(responder);
    const transitions: [string, string][] = [];
    let targets: MonitorTarget[] = [target];
    const monitor = createUpstreamMonitor({
      listEnabled: () => targets,
      fetch: fetchMock,
      onTransition: (name, to) => transitions.push([name, to]),
    });
    return { monitor, fetchMock, transitions, setTargets: (next: MonitorTarget[]) => (targets = next) };
  }

  const up = async () => jsonResponse(200, { data: [] });
  const down = async (): Promise<Response> => {
    throw new Error("ECONNREFUSED");
  };

  it("未探测过的上游是 unknown", () => {
    const { monitor } = setup(up);
    expect(monitor.snapshot("strata").state).toBe("unknown");
  });

  it("定时探测：可达的上游每个间隔探测一次", async () => {
    const { monitor, fetchMock } = setup(up);
    monitor.start();
    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS * 2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(monitor.snapshot("strata").state).toBe("reachable"));
    monitor.stop();
  });

  it("转为不可达后停止定时探测，并上报一次状态变化", async () => {
    const { monitor, fetchMock, transitions } = setup(down);
    monitor.start();
    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS * FAILURE_THRESHOLD);
    expect(monitor.snapshot("strata").state).toBe("unreachable");
    expect(fetchMock).toHaveBeenCalledTimes(FAILURE_THRESHOLD);
    expect(transitions).toEqual([["strata", "unreachable"]]);

    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS * 5);
    expect(fetchMock).toHaveBeenCalledTimes(FAILURE_THRESHOLD);
    monitor.stop();
  });

  it("activate：后台探测一次，受限频约束；成功后恢复并上报", async () => {
    let alive = false;
    const { monitor, fetchMock, transitions } = setup(() => (alive ? up() : down()));
    for (let i = 0; i < FAILURE_THRESHOLD; i++) monitor.report("strata", false, "ECONNREFUSED");
    expect(monitor.snapshot("strata").state).toBe("unreachable");

    alive = true;
    monitor.activate("strata");
    monitor.activate("strata");
    await vi.waitFor(() => expect(monitor.snapshot("strata").state).toBe("reachable"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(transitions).toEqual([
      ["strata", "unreachable"],
      ["strata", "recovered"],
    ]);
  });

  it("activate 对未登记或已停用的上游不做任何事", async () => {
    const { monitor, fetchMock } = setup(up);
    monitor.activate("ghost");
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("report：转发结果直接喂给状态机，不发请求", () => {
    const { monitor, fetchMock } = setup(up);
    monitor.report("strata", true);
    expect(monitor.snapshot("strata").state).toBe("reachable");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("probeNow：立即探测并返回结果，不受限频约束", async () => {
    const { monitor, fetchMock } = setup(up);
    const first = await monitor.probeNow("strata");
    const second = await monitor.probeNow("strata");
    expect(first?.ok).toBe(true);
    expect(second?.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await monitor.probeNow("ghost")).toBeNull();
  });

  it("上游被停用或删除后，下一轮定时探测清掉它的状态", async () => {
    const { monitor, setTargets } = setup(up);
    monitor.start();
    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS);
    await vi.waitFor(() => expect(monitor.snapshot("strata").state).toBe("reachable"));

    setTargets([]);
    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS);
    expect(monitor.snapshot("strata").state).toBe("unknown");
    monitor.stop();
  });

  it("探测在途时上游被停用，迟到的结果不写回状态也不上报", async () => {
    let release: (response: Response) => void = () => {};
    const { monitor, transitions, setTargets } = setup(() => new Promise<Response>((resolve) => (release = resolve)));
    const pending = monitor.probeNow("strata");
    setTargets([]);
    release(jsonResponse(200, { data: [] }));
    expect((await pending)?.ok).toBe(true);
    expect(monitor.snapshot("strata").state).toBe("unknown");
    expect(transitions).toEqual([]);
  });

  it("report 对不在启用集合里的名字不建状态也不上报", () => {
    const { monitor, transitions } = setup(up);
    for (let i = 0; i < FAILURE_THRESHOLD; i++) monitor.report("ghost", false, "ECONNREFUSED");
    expect(monitor.snapshot("ghost").state).toBe("unknown");
    expect(transitions).toEqual([]);
  });
});
