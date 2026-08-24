import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * 模块级 mock（与 client.test.ts 同款策略）：@huggingface/hub 的 whoAmI 换成
 * 可编程 mock；HubApiError 换成测试可构造的子类（实现侧只做 instanceof +
 * statusCode 判断）。undici 的 ProxyAgent 仅记录构造参数（proxy 分支断言用）。
 */
const { whoAmIMock } = vi.hoisted(() => ({ whoAmIMock: vi.fn() }));

vi.mock("@huggingface/hub", () => {
  class HubApiError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number) {
      super(message);
      this.statusCode = statusCode;
    }
  }
  return {
    whoAmI: (params: unknown) => whoAmIMock(params),
    HubApiError,
  };
});

const { ProxyAgentMock } = vi.hoisted(() => ({ ProxyAgentMock: vi.fn() }));
vi.mock("undici", async (importOriginal) => ({
  ...(await importOriginal<typeof import("undici")>()),
  ProxyAgent: ProxyAgentMock,
}));

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { HubApiError } from "@huggingface/hub";
import { getDb, _resetDbForTest } from "../db";
import { _resetPanelConfigForTest } from "../panelConfig";
import { interpretWhoAmIError, testHfConnection } from "./verify";
import {
  clearHfToken,
  getHfSettingsSnapshot,
  parseHfMirror,
  parseHfToken,
  saveHfToken,
} from "./settings";

describe("testHfConnection（whoAmI 连通测试）", () => {
  beforeEach(() => {
    whoAmIMock.mockReset();
    ProxyAgentMock.mockReset();
  });

  it("成功：account 取 whoAmI 返回的 name，anonymous=false；hubUrl/accessToken 透传", async () => {
    whoAmIMock.mockResolvedValue({ id: "u1", type: "user", name: "octocat" });

    const result = await testHfConnection({ endpoint: "https://hf-mirror.com", token: "hf_abc" });

    expect(result).toEqual({ ok: true, account: "octocat", anonymous: false });
    expect(whoAmIMock).toHaveBeenCalledWith({
      hubUrl: "https://hf-mirror.com",
      accessToken: "hf_abc",
      fetch: undefined,
    });
  });

  it("镜像/代理均未配置时 hubUrl 与 fetch 为 undefined（官方端点 + 直连）", async () => {
    whoAmIMock.mockResolvedValue({ id: "u1", type: "user", name: "octocat" });

    await testHfConnection({});
    expect(whoAmIMock).toHaveBeenCalledWith({
      hubUrl: undefined,
      accessToken: undefined,
      fetch: undefined,
    });
  });

  it("配置 proxy 时注入 ProxyAgent 包装的 fetch（uri 等于 proxy 值）", async () => {
    whoAmIMock.mockResolvedValue({ id: "u1", type: "user", name: "octocat" });

    await testHfConnection({ token: "hf_abc", proxy: "http://127.0.0.1:7890" });

    expect(ProxyAgentMock).toHaveBeenCalledWith({ uri: "http://127.0.0.1:7890" });
    expect(typeof (whoAmIMock.mock.calls[0][0] as { fetch?: typeof fetch }).fetch).toBe("function");
  });

  it("匿名 + 401 = 端点可达的成功语义（account=anonymous）", async () => {
    whoAmIMock.mockRejectedValue(new HubApiError("Invalid username or password.", 401));

    await expect(testHfConnection({})).resolves.toEqual({
      ok: true,
      account: "anonymous",
      anonymous: true,
    });
  });

  it.each([
    [401, "Token 无效"],
    [403, "Token 无效"],
    [429, "HF 限流，建议配置 Token 或稍后重试"],
  ])("带 Token 时 HTTP %s → 中文失败文案", async (status, message) => {
    whoAmIMock.mockRejectedValue(new HubApiError("boom", status));
    await expect(testHfConnection({ token: "hf_bad" })).rejects.toThrow(message);
  });

  it("其余 HubApiError → 状态码 + 原始 message；匿名 401 之外的异常不落入成功分支", async () => {
    whoAmIMock.mockRejectedValue(new HubApiError("server exploded", 500));
    await expect(testHfConnection({})).rejects.toThrow("HF API 错误(HTTP 500): server exploded");
    // 匿名但非 401（如 429）仍按失败映射
    whoAmIMock.mockRejectedValue(new HubApiError("slow down", 429));
    await expect(testHfConnection({})).rejects.toThrow("HF 限流，建议配置 Token 或稍后重试");
  });

  it("网络层异常（TypeError: fetch failed）→ HF 网络错误 + 原始 message", async () => {
    whoAmIMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(testHfConnection({ token: "hf_abc" })).rejects.toThrow("HF 网络错误: fetch failed");
  });

  it("库内 Token 非 hf_ 前缀（PUT 允许的 32+ 长令牌）→ 前置拦截且不发起请求", async () => {
    await expect(
      testHfConnection({ token: "x".repeat(40) }),
    ).rejects.toThrow("Token 格式错误: 必须以 hf_ 开头");
    expect(whoAmIMock).not.toHaveBeenCalled();
  });
});

describe("interpretWhoAmIError（异常裁决，纯函数）", () => {
  it("anonymous=true + 401 → 成功结果；anonymous=false + 401 → Token 无效", () => {
    const err = new HubApiError("Invalid username or password.", 401);
    expect(interpretWhoAmIError(err, true)).toEqual({
      ok: true,
      account: "anonymous",
      anonymous: true,
    });
    expect(interpretWhoAmIError(err, false)).toBeInstanceOf(Error);
  });

  it("匿名 + 403 不落入成功分支（403 是明确的拒绝而非匿名语义）", () => {
    const result = interpretWhoAmIError(new HubApiError("forbidden", 403), true);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toBe("Token 无效");
  });
});

/** settings.ts 用例的隔离环境：:memory: 库 + 缺失的 PANEL_CONFIG（proxy 未配置）+ 无 HF_TOKEN */
describe("hf/settings（快照与写入校验）", () => {
  let envBackup: { PANEL_DB?: string; PANEL_CONFIG?: string; HF_TOKEN?: string };
  const missingConfig = path.join(tmpdir(), `llamapad-hf-settings-missing-${process.pid}`, "panel.yaml");

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

  it("全未配置：{ tokenSource: null, tokenSet: false, tokenTail: null, hfMirror: 'official', proxy: null }", () => {
    expect(getHfSettingsSnapshot()).toEqual({
      tokenSource: null,
      tokenSet: false,
      tokenTail: null,
      hfMirror: "official",
      proxy: null,
    });
  });

  it("Token 来源与尾 4 位：env 优先；env 清除后回落 db 单行", () => {
    saveHfToken(getDb(), "hf_aaaaaaaaaaaaaaaaaaaaaaaaaaaaabbb");
    process.env.HF_TOKEN = "hf_envenvenvenvenvenvenvenvenv1234";

    let snap = getHfSettingsSnapshot();
    expect(snap.tokenSource).toBe("env");
    expect(snap.tokenSet).toBe(true);
    expect(snap.tokenTail).toBe("1234");

    delete process.env.HF_TOKEN;
    snap = getHfSettingsSnapshot();
    expect(snap.tokenSource).toBe("db");
    expect(snap.tokenTail).toBe("abbb"); // 尾 4 位 = …abbb

    clearHfToken(getDb());
    snap = getHfSettingsSnapshot();
    expect(snap.tokenSource).toBeNull();
    expect(snap.tokenTail).toBeNull();
    expect(snap.tokenSet).toBe(false);
  });

  it("saveHfToken 为单行 replace（旧行被清除，仅剩新行）", () => {
    const db = getDb();
    saveHfToken(db, "hf_oldoldoldoldoldoldoldoldoldold1");
    saveHfToken(db, "hf_newnewnewnewnewnewnewnewnewnew2");
    const rows = db.prepare("SELECT token FROM hf_token").all() as { token: string }[];
    expect(rows).toEqual([{ token: "hf_newnewnewnewnewnewnewnewnewnew2" }]);
  });

  it("镜像快照：settings.hf_mirror 存值原样透出；缺失回 official；proxy 来自 panel.yaml", () => {
    const db = getDb();
    db.prepare("INSERT INTO settings(key, value) VALUES ('hf_mirror', ?)").run(
      "https://hf-mirror.com",
    );
    const dir = path.join(tmpdir(), `llamapad-hf-settings-proxy-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "panel.yaml");
    writeFileSync(file, "proxy: http://127.0.0.1:7890\n", "utf8");
    process.env.PANEL_CONFIG = file;
    _resetPanelConfigForTest();

    const snap = getHfSettingsSnapshot();
    expect(snap.hfMirror).toBe("https://hf-mirror.com");
    expect(snap.proxy).toBe("http://127.0.0.1:7890");
  });

  it("parseHfMirror：official 与 http(s) URL 通过；ftp/裸串/空串拒绝", () => {
    expect(parseHfMirror("official")).toBe("official");
    expect(parseHfMirror("https://hf-mirror.com")).toBe("https://hf-mirror.com");
    expect(parseHfMirror("http://intranet-hf.corp:8080/")).toBe("http://intranet-hf.corp:8080/");

    expect(() => parseHfMirror("ftp://x")).toThrow("hfMirror 协议非法");
    expect(() => parseHfMirror("hf-mirror.com")).toThrow("hfMirror 非法");
    expect(() => parseHfMirror("")).toThrow("hfMirror 非法");
  });

  it("parseHfToken：hf_ 前缀或 ≥32 字符通过；短裸串/空串拒绝", () => {
    expect(parseHfToken("hf_short")).toBe("hf_short");
    expect(parseHfToken("x".repeat(32))).toBe("x".repeat(32));
    expect(() => parseHfToken("short")).toThrow("token 格式非法");
    expect(() => parseHfToken("")).toThrow("token 格式非法");
  });
});
