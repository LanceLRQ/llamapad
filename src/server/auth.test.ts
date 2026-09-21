import { afterAll, afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDb, runMigrations } from "./db";
import {
  createAdminIfEmpty,
  createSession,
  generateApiToken,
  getApiTokenPlain,
  getOrCreateSessionSecret,
  hashPassword,
  hashToken,
  issueApiToken,
  listApiTokens,
  requireAuth,
  revokeApiToken,
  syncAdminPasswordFromEnv,
  verifyAdminPassword,
  verifyPassword,
  verifySession,
} from "./auth";

/** 每个用例独立的 :memory: 库（迁移到 v1） */
function makeDb(): Database.Database {
  const db = openDb(":memory:");
  runMigrations(db);
  return db;
}

const TEST_SECRET = "0123456789abcdef0123456789abcdef";

/** PANEL_SECRET / PANEL_ADMIN_PASSWORD 环境变量用后还原，避免污染其他用例 */
const panelSecretBackup = process.env.PANEL_SECRET;
const adminPwBackup = process.env.PANEL_ADMIN_PASSWORD;

function restoreEnv() {
  if (panelSecretBackup === undefined) delete process.env.PANEL_SECRET;
  else process.env.PANEL_SECRET = panelSecretBackup;
  if (adminPwBackup === undefined) delete process.env.PANEL_ADMIN_PASSWORD;
  else process.env.PANEL_ADMIN_PASSWORD = adminPwBackup;
}

afterEach(restoreEnv);

afterAll(restoreEnv);

describe("scrypt 密码哈希", () => {
  it("hashPassword 输出 scrypt$saltHex$hashHex 格式，同密码两次哈希盐不同", async () => {
    const stored = await hashPassword("correct horse battery staple");
    expect(stored).toMatch(/^scrypt\$[0-9a-f]+\$[0-9a-f]+$/);
    const again = await hashPassword("correct horse battery staple");
    expect(again).not.toBe(stored); // 随机盐
  });

  it("verifyPassword 正确密码通过、错误密码拒绝", async () => {
    const stored = await hashPassword("s3cret-pw");
    await expect(verifyPassword("s3cret-pw", stored)).resolves.toBe(true);
    await expect(verifyPassword("wrong-pw", stored)).resolves.toBe(false);
  });

  it("格式坏的 stored 拒绝（返回 false）而非抛异常", async () => {
    await expect(verifyPassword("x", "plaintext")).resolves.toBe(false);
    await expect(verifyPassword("x", "scrypt$zz-not-hex$deadbeef")).resolves.toBe(false);
    await expect(verifyPassword("x", "scrypt$onlyonepart")).resolves.toBe(false);
    await expect(verifyPassword("x", "bcrypt$abcd$ef01")).resolves.toBe(false);
    await expect(verifyPassword("x", "")).resolves.toBe(false);
  });
});

describe("session 签发/校验", () => {
  it("createSession 生成 exp.hmacHex，未过期时 verifySession 返回 {ok,exp}", () => {
    const before = Math.floor(Date.now() / 1000);
    const token = createSession(TEST_SECRET, 3600);
    const after = Math.floor(Date.now() / 1000);
    expect(token).toMatch(/^\d+\.[0-9a-f]{64}$/);
    const result = verifySession(token, TEST_SECRET);
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(true);
    // exp 落在 [签发前+ttl, 签发后+ttl] 区间
    expect(result!.exp).toBeGreaterThanOrEqual(before + 3600);
    expect(result!.exp).toBeLessThanOrEqual(after + 3600);
  });

  it("ttl=0 立即过期，返回 null", () => {
    const token = createSession(TEST_SECRET, 0);
    expect(verifySession(token, TEST_SECRET)).toBeNull();
  });

  it("篡改 exp 或 hmac 返回 null；换 secret 返回 null；乱格式返回 null", () => {
    const token = createSession(TEST_SECRET, 3600);
    const [exp, hmac] = token.split(".");

    // 篡改 exp（伪造更晚过期）
    const forgedExp = `${Number(exp) + 99999}.${hmac}`;
    expect(verifySession(forgedExp, TEST_SECRET)).toBeNull();
    // 篡改 hmac
    const flipped = hmac.slice(0, -1) + (hmac.endsWith("0") ? "1" : "0");
    expect(verifySession(`${exp}.${flipped}`, TEST_SECRET)).toBeNull();
    // 换 secret 校验
    expect(verifySession(token, "another-secret-entirely")).toBeNull();
    // 乱格式
    expect(verifySession("garbage", TEST_SECRET)).toBeNull();
    expect(verifySession("", TEST_SECRET)).toBeNull();
    expect(verifySession("1234567890.abcdef", TEST_SECRET)).toBeNull(); // hmac 长度不对
    expect(verifySession(`notanumber.${hmac}`, TEST_SECRET)).toBeNull();
  });
});

describe("API token", () => {
  it("generateApiToken 形如 lp_ + 43 位 urlsafe 随机串，两次生成不同", () => {
    const token = generateApiToken();
    expect(token).toMatch(/^lp_[A-Za-z0-9_-]{43}$/);
    expect(generateApiToken()).not.toBe(token);
  });

  it("hashToken 是 sha256 hex 且 api_tokens 存哈希后 Bearer 可用过 requireAuth", async () => {
    const token = generateApiToken();
    const hash = hashToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).toBe(hash); // 确定性

    const db = makeDb();
    db.prepare("INSERT INTO api_tokens(token_hash, name, created_at) VALUES (?, ?, ?)").run(
      hash,
      "ci",
      Date.now(),
    );

    const req = new Request("http://x/api/v1/models", {
      headers: { authorization: `Bearer ${token}` },
    });
    await expect(requireAuth(req, db)).resolves.toEqual({ ok: true });
  });
});

describe("requireAuth", () => {
  function req(headers: Record<string, string>): Request {
    return new Request("http://x/api/v1/models", { headers });
  }

  it("无凭证 → 401 JSON { error: 'unauthorized' }", async () => {
    const db = makeDb();
    const result = await requireAuth(req({}), db);
    expect(result).toBeInstanceOf(Response);
    const res = result as Response;
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("坏 session cookie / 不存在的 Bearer → 401", async () => {
    const db = makeDb();
    const badCookie = await requireAuth(
      req({ cookie: "llamapad_session=9999999999999.deadbeef" }),
      db,
    );
    expect(badCookie).toBeInstanceOf(Response);
    expect((badCookie as Response).status).toBe(401);

    const badBearer = await requireAuth(req({ authorization: "Bearer lp_nonexistent" }), db);
    expect(badBearer).toBeInstanceOf(Response);
    expect((badBearer as Response).status).toBe(401);
  });

  it("Cookie 含合法未过期 session → ok（secret 从 db 设置派生）", async () => {
    const db = makeDb();
    const secret = getOrCreateSessionSecret(db);
    const token = createSession(secret, 600);
    const result = await requireAuth(req({ cookie: `llamapad_session=${token}` }), db);
    expect(result).toEqual({ ok: true });
  });

  it("allowBearer:false 时 Bearer 被拒（仅 session 可用），session 仍可用", async () => {
    const db = makeDb();
    const token = generateApiToken();
    db.prepare("INSERT INTO api_tokens(token_hash, name, created_at) VALUES (?, ?, ?)").run(
      hashToken(token),
      null,
      Date.now(),
    );

    const bearerReq = new Request("http://x/api/v1/auth/tokens", {
      headers: { authorization: `Bearer ${token}` },
    });
    const denied = await requireAuth(bearerReq, db, { allowBearer: false });
    expect(denied).toBeInstanceOf(Response);
    expect((denied as Response).status).toBe(401);

    const secret = getOrCreateSessionSecret(db);
    const sessionToken = createSession(secret, 600);
    const sessionReq = new Request("http://x/api/v1/auth/tokens", {
      headers: { cookie: `llamapad_session=${sessionToken}` },
    });
    expect(await requireAuth(sessionReq, db, { allowBearer: false })).toEqual({ ok: true });
  });

  it("多 cookie 时正确定位 llamapad_session", async () => {
    const db = makeDb();
    const secret = getOrCreateSessionSecret(db);
    const token = createSession(secret, 600);
    const result = await requireAuth(
      req({ cookie: `theme=dark; llamapad_session=${token}; other=1` }),
      db,
    );
    expect(result).toEqual({ ok: true });
  });
});

describe("getOrCreateSessionSecret", () => {
  it("首次生成 32 字节 hex 写入 settings，重复调用幂等返回同值", () => {
    const db = makeDb();
    const s1 = getOrCreateSessionSecret(db);
    expect(s1).toMatch(/^[0-9a-f]{64}$/);
    const s2 = getOrCreateSessionSecret(db);
    expect(s2).toBe(s1);
    // 直接查库确认已持久化
    const row = db.prepare("SELECT value FROM settings WHERE key = 'session_secret'").get() as {
      value: string;
    };
    expect(row.value).toBe(s1);
  });

  it("PANEL_SECRET 环境变量优先（且不覆盖库内已有值）", () => {
    const db = makeDb();
    process.env.PANEL_SECRET = "env-secret-for-test";
    try {
      expect(getOrCreateSessionSecret(db)).toBe("env-secret-for-test");
      // 环境变量存在时不写入 settings
      const row = db
        .prepare("SELECT value FROM settings WHERE key = 'session_secret'")
        .get() as { value: string } | undefined;
      expect(row).toBeUndefined();
    } finally {
      delete process.env.PANEL_SECRET;
    }
  });
});

describe("createAdminIfEmpty / verifyAdminPassword", () => {
  it("admins 为空时写入哈希；非空时抛错防重复 bootstrap", async () => {
    const db = makeDb();
    await createAdminIfEmpty(db, "initial-pw");

    const count = db.prepare("SELECT COUNT(*) AS c FROM admins").get() as { c: number };
    expect(count.c).toBe(1);

    await expect(createAdminIfEmpty(db, "second-pw")).rejects.toThrow();

    const stillOne = db.prepare("SELECT COUNT(*) AS c FROM admins").get() as { c: number };
    expect(stillOne.c).toBe(1);
  });

  it("verifyAdminPassword 遍历 admins：正确密码 true、错误 false、空表 false", async () => {
    const db = makeDb();
    expect(await verifyAdminPassword(db, "whatever")).toBe(false); // 空表

    await createAdminIfEmpty(db, "right-pw");
    expect(await verifyAdminPassword(db, "right-pw")).toBe(true);
    expect(await verifyAdminPassword(db, "right-pw ")).toBe(false);
    expect(await verifyAdminPassword(db, "")).toBe(false);
  });
});

describe("syncAdminPasswordFromEnv（.env 为管理员密码唯一真源）", () => {
  function events(db: Database.Database): { kind: string; message: string }[] {
    return db.prepare("SELECT kind, message FROM events ORDER BY id").all() as {
      kind: string;
      message: string;
    }[];
  }

  it("环境变量未设：不做任何事，返回 skipped", async () => {
    const db = makeDb();
    delete process.env.PANEL_ADMIN_PASSWORD;
    expect(await syncAdminPasswordFromEnv(db)).toBe("skipped");
    const { c } = db.prepare("SELECT COUNT(*) AS c FROM admins").get() as { c: number };
    expect(c).toBe(0);
  });

  it("admins 为空：按环境变量创建管理员，返回 created", async () => {
    const db = makeDb();
    process.env.PANEL_ADMIN_PASSWORD = "env-boot-pw";
    expect(await syncAdminPasswordFromEnv(db)).toBe("created");
    expect(await verifyAdminPassword(db, "env-boot-pw")).toBe(true);
  });

  it("库内密码与环境变量一致：不改动、不轮换会话密钥、不写事件，返回 unchanged", async () => {
    const db = makeDb();
    await createAdminIfEmpty(db, "same-pw-123");
    const secretBefore = getOrCreateSessionSecret(db);
    process.env.PANEL_ADMIN_PASSWORD = "same-pw-123";
    expect(await syncAdminPasswordFromEnv(db)).toBe("unchanged");
    expect(getOrCreateSessionSecret(db)).toBe(secretBefore);
    expect(events(db)).toHaveLength(0);
  });

  it("不一致：更新哈希、轮换会话密钥使旧会话失效、写 auth.password_sync 事件，返回 updated", async () => {
    const db = makeDb();
    delete process.env.PANEL_SECRET;
    await createAdminIfEmpty(db, "old-pw-123");
    const oldSecret = getOrCreateSessionSecret(db);
    const oldSession = createSession(oldSecret, 3600);
    process.env.PANEL_ADMIN_PASSWORD = "new-pw-456";

    expect(await syncAdminPasswordFromEnv(db)).toBe("updated");
    expect(await verifyAdminPassword(db, "new-pw-456")).toBe(true);
    expect(await verifyAdminPassword(db, "old-pw-123")).toBe(false);
    const newSecret = getOrCreateSessionSecret(db);
    expect(newSecret).not.toBe(oldSecret);
    expect(verifySession(oldSession, newSecret)).toBeNull();
    const ev = events(db);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.kind).toBe("auth.password_sync");
    expect(ev[0]!.message).toContain("全部登录会话已失效");
  });

  it("不一致且设了 PANEL_SECRET：照常更新密码，事件注明旧会话未失效", async () => {
    const db = makeDb();
    await createAdminIfEmpty(db, "old-pw-123");
    process.env.PANEL_SECRET = TEST_SECRET;
    process.env.PANEL_ADMIN_PASSWORD = "new-pw-456";
    expect(await syncAdminPasswordFromEnv(db)).toBe("updated");
    expect(await verifyAdminPassword(db, "new-pw-456")).toBe(true);
    expect(events(db)[0]!.message).toContain("PANEL_SECRET");
  });

  it("同一个 db 在进程内只同步一次：环境变量随后改变不再生效（env 在进程生命周期内不变）", async () => {
    const db = makeDb();
    process.env.PANEL_ADMIN_PASSWORD = "first-pw-123";
    expect(await syncAdminPasswordFromEnv(db)).toBe("created");
    process.env.PANEL_ADMIN_PASSWORD = "second-pw-456";
    expect(await syncAdminPasswordFromEnv(db)).toBe("created");
    expect(await verifyAdminPassword(db, "first-pw-123")).toBe(true);
  });

  it("并发调用共享同一次同步，不会重复创建管理员", async () => {
    const db = makeDb();
    process.env.PANEL_ADMIN_PASSWORD = "race-pw-123";
    const results = await Promise.all([syncAdminPasswordFromEnv(db), syncAdminPasswordFromEnv(db)]);
    expect(results).toEqual(["created", "created"]);
    const { c } = db.prepare("SELECT COUNT(*) AS c FROM admins").get() as { c: number };
    expect(c).toBe(1);
  });
});

describe("API token 生命周期", () => {
  it("listApiTokens 返回 id/name/created_at/尾 4 位，不含明文与完整哈希", () => {
    const db = makeDb();
    const token = issueApiToken(db, "plugin");
    const rows = listApiTokens(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("plugin");
    expect(rows[0]!.tail).toBe(token.slice(-4));
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it("listApiTokens 的 hasPlain 依据 token_plain 是否为 NULL，不依据 tail 是否为空", () => {
    const db = makeDb();
    issueApiToken(db, "fresh"); // 新签发：有明文
    // 手工构造一行 tail 非空但没有明文——对应 v4~v17 之间签发的历史行
    db.prepare(
      "INSERT INTO api_tokens(token_hash, name, created_at, token_tail) VALUES (?, ?, ?, ?)",
    ).run("d".repeat(64), "no-plain", 111, "abcd");

    const rows = listApiTokens(db);
    const fresh = rows.find((r) => r.name === "fresh");
    const legacy = rows.find((r) => r.name === "no-plain");
    expect(fresh?.hasPlain).toBe(true);
    expect(legacy?.tail).toBe("abcd"); // tail 非空
    expect(legacy?.hasPlain).toBe(false); // 但没有明文——不能靠 tail 判定
  });

  it("revokeApiToken 后该 token 立即失效", async () => {
    const db = makeDb();
    const token = issueApiToken(db, null);
    const rows = listApiTokens(db);
    expect(revokeApiToken(db, rows[0]!.id)).toBe(true);
    expect(listApiTokens(db)).toHaveLength(0);
    // 鉴权侧同步失效
    const req = new Request("http://panel/api/v1/models", { headers: { authorization: `Bearer ${token}` } });
    expect(await requireAuth(req, db)).toBeInstanceOf(Response);
  });

  it("吊销不存在的 id 返回 false（route 据此给 404）", () => {
    const db = makeDb();
    expect(revokeApiToken(db, 9999)).toBe(false);
  });
});

describe("getApiTokenPlain", () => {
  it("签发后取回的明文与签发返回值一致", () => {
    const db = makeDb();
    const token = issueApiToken(db, "plugin");
    const rows = listApiTokens(db);
    expect(getApiTokenPlain(db, rows[0]!.id)).toBe(token);
  });

  it("id 不存在返回 null", () => {
    const db = makeDb();
    expect(getApiTokenPlain(db, 9999)).toBeNull();
  });

  it("token_plain 为 NULL 的历史行（v18 之前签发）返回 null", () => {
    const db = makeDb();
    const info = db
      .prepare("INSERT INTO api_tokens(token_hash, name, created_at, token_tail) VALUES (?, ?, ?, ?)")
      .run("c".repeat(64), "legacy", 111, "abcd");
    expect(getApiTokenPlain(db, Number(info.lastInsertRowid))).toBeNull();
  });
});
