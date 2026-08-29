import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * 模块级 mock（vi.mock 工厂被提升到文件顶部，外部变量须经 vi.hoisted 引入）：
 * - @huggingface/hub：listFiles 换成可编程的异步生成器 mock；HubApiError 换成
 *   测试可构造的子类（实现侧只做 instanceof + statusCode 判断，构造签名测试自定）
 * - undici：仅替换 ProxyAgent（记录构造参数、每次 new 产生独立实例），其余导出保持原样
 */
const { listFilesMock } = vi.hoisted(() => ({ listFilesMock: vi.fn() }));

vi.mock("@huggingface/hub", () => {
  class HubApiError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number) {
      super(message);
      this.statusCode = statusCode;
    }
  }
  return {
    listFiles: (params: unknown) => listFilesMock(params),
    HubApiError,
  };
});

const { ProxyAgentMock, undiciFetchMock } = vi.hoisted(() => ({
  ProxyAgentMock: vi.fn(),
  undiciFetchMock: vi.fn(),
}));
vi.mock("undici", async (importOriginal) => ({
  ...(await importOriginal<typeof import("undici")>()),
  ProxyAgent: ProxyAgentMock,
  fetch: undiciFetchMock,
}));

import { HubApiError } from "@huggingface/hub";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveHfOptions, listRepoFiles } from "./client";
import { getDb, _resetDbForTest } from "../db";
import { _resetPanelConfigForTest } from "../panelConfig";
import { _resetProxyAgentCacheForTest } from "../proxyAgentCache";

/** hub 的 ListFileEntry 形状（测试夹具用，字段见 node_modules 类型声明） */
interface HubEntry {
  type: "file" | "directory" | "unknown";
  path: string;
  size: number;
  oid?: string;
  lfs?: { oid: string; size: number; pointerSize: number };
}

/** 让 listFiles mock 依次产出这些条目（异步生成器，与真实签名一致） */
function givenHubEntries(entries: HubEntry[]): void {
  listFilesMock.mockImplementation(async function* () {
    for (const e of entries) yield e;
  });
}

describe("listRepoFiles（HF 仓库文件列表）", () => {
  beforeEach(() => {
    listFilesMock.mockReset();
    ProxyAgentMock.mockReset();
    undiciFetchMock.mockReset();
    // proxyAgentCache 是跨用例持久的进程级缓存（globalThis 挂载），
    // 不清空的话后面用例会复用前面用例留下的实例，导致 ProxyAgentMock
    // 的调用次数断言随用例顺序漂移。
    _resetProxyAgentCacheForTest();
  });

  it("映射 hub 条目：LFS 取 lfs.size/lfs.oid，普通文件取自身 size 且 oid 为 undefined，目录被排除", async () => {
    givenHubEntries([
      { type: "file", path: "README.md", size: 4321, oid: "6b1a git blob sha" },
      {
        type: "file",
        path: "gemma-2-9b-IT-Q4_K_M.gguf",
        size: 232, // LFS 指针文件本身的大小，不是模型大小
        oid: "git blob sha",
        lfs: { oid: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", size: 5780403200, pointerSize: 232 },
      },
      { type: "directory", path: "subdir", size: 0 },
    ]);

    const files = await listRepoFiles("bartowski/gemma-2-9b-it-GGUF");

    expect(files).toEqual([
      { path: "README.md", size: 4321, oid: undefined },
      {
        path: "gemma-2-9b-IT-Q4_K_M.gguf",
        size: 5780403200,
        oid: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      },
    ]);

    // 透传：repo 原样、recursive 必须 true（一次拉全仓库树）
    expect(listFilesMock).toHaveBeenCalledTimes(1);
    const params = listFilesMock.mock.calls[0][0] as Record<string, unknown>;
    expect(params.repo).toBe("bartowski/gemma-2-9b-it-GGUF");
    expect(params.recursive).toBe(true);
  });

  it("endpoint 未传时 hubUrl 为 undefined（走官方默认）；传镜像时出现在调用参数", async () => {
    givenHubEntries([]);

    await listRepoFiles("org/repo");
    expect((listFilesMock.mock.calls[0][0] as Record<string, unknown>).hubUrl).toBeUndefined();

    await listRepoFiles("org/repo", { endpoint: "https://hf-mirror.com" });
    expect((listFilesMock.mock.calls[1][0] as Record<string, unknown>).hubUrl).toBe("https://hf-mirror.com");
  });

  it("token 传入时 accessToken 等于 token；不传时为 undefined（匿名）", async () => {
    givenHubEntries([]);

    await listRepoFiles("org/repo", { token: "hf_abc123" });
    expect((listFilesMock.mock.calls[0][0] as Record<string, unknown>).accessToken).toBe("hf_abc123");

    await listRepoFiles("org/repo");
    expect((listFilesMock.mock.calls[1][0] as Record<string, unknown>).accessToken).toBeUndefined();
  });

  it("proxy 传入时注入 undici ProxyAgent（uri 等于 proxy 值）作为 fetch 的 dispatcher；不传时 fetch 为 undefined", async () => {
    givenHubEntries([]);

    await listRepoFiles("org/repo");
    expect((listFilesMock.mock.calls[0][0] as Record<string, unknown>).fetch).toBeUndefined();

    await listRepoFiles("org/repo", { proxy: "http://127.0.0.1:7890" });
    expect(ProxyAgentMock).toHaveBeenCalledTimes(1);
    expect(ProxyAgentMock).toHaveBeenCalledWith({ uri: "http://127.0.0.1:7890" });

    // 传给 hub 的 fetch 包装器：调用时把 ProxyAgent 实例放进 init.dispatcher，且必须走
    // undici 包自己的 fetch——全局 fetch 是 Node 内置的另一份 undici，会拒收外部
    // ProxyAgent 实例作为 dispatcher（真机复现的 UND_ERR_INVALID_ARG）
    const fetchFn = (listFilesMock.mock.calls[1][0] as { fetch?: typeof fetch }).fetch;
    expect(typeof fetchFn).toBe("function");
    const agent = ProxyAgentMock.mock.instances[0];
    const globalFetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("[]"));
    undiciFetchMock.mockResolvedValue(new Response("[]"));
    try {
      await fetchFn!("https://huggingface.co/api/models/org/repo/tree/main", { headers: { accept: "application/json" } });
      expect(undiciFetchMock).toHaveBeenCalledWith(
        "https://huggingface.co/api/models/org/repo/tree/main",
        expect.objectContaining({ headers: { accept: "application/json" }, dispatcher: agent }),
      );
      expect(globalFetchSpy).not.toHaveBeenCalled();
    } finally {
      globalFetchSpy.mockRestore();
    }
  });

  it.each([
    [401, "Token 无效或仓库受限（gated repo 需要在 HF 页面申请）"],
    [403, "Token 无效或仓库受限（gated repo 需要在 HF 页面申请）"],
  ])("HTTP %s → 提示 Token/gated 仓库", async (status, message) => {
    listFilesMock.mockImplementation(() => {
      throw new HubApiError("unauthorized", status);
    });
    await expect(listRepoFiles("org/gated")).rejects.toThrow(message);
  });

  it("HTTP 404 → 仓库不存在并带 repo 名", async () => {
    listFilesMock.mockImplementation(() => {
      throw new HubApiError("not found", 404);
    });
    await expect(listRepoFiles("org/missing")).rejects.toThrow("仓库不存在: org/missing");
  });

  it("HTTP 429 → 限流提示", async () => {
    listFilesMock.mockImplementation(() => {
      throw new HubApiError("too many requests", 429);
    });
    await expect(listRepoFiles("org/repo")).rejects.toThrow("HF 限流，建议配置 Token 或稍后重试");
  });

  it("网络错误（非 HubApiError）→ 保留原始 message 的 HF 网络错误", async () => {
    listFilesMock.mockImplementation(() => {
      throw new TypeError("fetch failed");
    });
    await expect(listRepoFiles("org/repo")).rejects.toThrow("HF 网络错误: fetch failed");
  });
});

/** resolveHfOptions 用例的隔离环境：:memory: 库 + 缺失的 PANEL_CONFIG（proxy 未配置）+ 无 HF_TOKEN */
describe("resolveHfOptions（生产配置组装）", () => {
  let envBackup: { PANEL_DB?: string; PANEL_CONFIG?: string; HF_TOKEN?: string };
  const missingConfig = path.join(tmpdir(), `llamapad-hf-client-missing-${process.pid}`, "panel.yaml");

  beforeEach(() => {
    envBackup = {
      PANEL_DB: process.env.PANEL_DB,
      PANEL_CONFIG: process.env.PANEL_CONFIG,
      HF_TOKEN: process.env.HF_TOKEN,
    };
    process.env.PANEL_DB = ":memory:";
    process.env.PANEL_CONFIG = missingConfig;
    delete process.env.HF_TOKEN;
    _resetDbForTest();
    _resetPanelConfigForTest();
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    _resetDbForTest();
    _resetPanelConfigForTest();
  });

  it("全部未配置时返回全 undefined 的空 options", async () => {
    expect(await resolveHfOptions()).toEqual({ endpoint: undefined, token: undefined, proxy: undefined });
  });

  it("token 优先级：env HF_TOKEN > hf_token 表首行（最早创建）", async () => {
    const db = getDb();
    db.prepare("INSERT INTO hf_token(token, note, created_at) VALUES (?, ?, ?)").run("hf_from_db_1", "a", 1000);
    db.prepare("INSERT INTO hf_token(token, note, created_at) VALUES (?, ?, ?)").run("hf_from_db_2", "b", 2000);

    expect((await resolveHfOptions()).token).toBe("hf_from_db_1"); // 表首行 = created_at 最早

    process.env.HF_TOKEN = "hf_from_env";
    expect((await resolveHfOptions()).token).toBe("hf_from_env"); // env 优先
  });

  it("endpoint：settings 的 hf_mirror 为 https 镜像时取该值；official 或未设置时 undefined", async () => {
    const insert = (v: string) =>
      getDb().prepare("INSERT INTO settings(key, value) VALUES ('hf_mirror', ?)").run(v);

    insert("https://hf-mirror.com");
    expect((await resolveHfOptions()).endpoint).toBe("https://hf-mirror.com");

    getDb().prepare("DELETE FROM settings").run();
    insert("official");
    expect((await resolveHfOptions()).endpoint).toBeUndefined();
  });

  it("proxy：来自 panel.yaml 的 proxy 字段", async () => {
    const dir = path.join(tmpdir(), `llamapad-hf-client-proxy-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "panel.yaml");
    writeFileSync(file, "proxy: http://127.0.0.1:7890\n", "utf8");
    process.env.PANEL_CONFIG = file;
    _resetPanelConfigForTest();

    expect((await resolveHfOptions()).proxy).toBe("http://127.0.0.1:7890");
  });
});
