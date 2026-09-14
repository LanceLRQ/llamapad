import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { installEnv, installedHome, sh, tempDir } from "./sh";

// 每条用例都会 fork bash 并 source 整个脚本，全量并行跑多个测试文件时进程调度可能让
// 单条用例超过 vitest 默认的 5s，故本文件整体调宽超时（不改 vitest.config.ts）
vi.setConfig({ testTimeout: 30_000 });

function tagsFixture(names: string[]): string {
  const f = path.join(tempDir(), "tags.json");
  writeFileSync(f, JSON.stringify({ results: names.map((name) => ({ name, images: [{ os: "linux" }] })) }));
  return `file://${f}`;
}

function rawFixture(files: Record<string, string>): string {
  const raw = tempDir("lp-raw-");
  for (const [ref, body] of Object.entries(files)) {
    mkdirSync(path.join(raw, ref, "deploy"), { recursive: true });
    writeFileSync(path.join(raw, ref, "deploy/llamapad.sh"), body);
  }
  return `file://${raw}`;
}

describe("版本检查", () => {
  it("fetch_latest_version 取 Docker Hub 上最大的正式版", () => {
    const env = { LLAMAPAD_HUB_TAGS_URL: tagsFixture(["latest", "0.1.0", "0.3.0-rc.1", "0.2.0"]) };
    expect(sh("fetch_latest_version", { env }).stdout).toBe("0.2.0\n");
  });

  it("update_check_cached 24 小时内只查一次", () => {
    const { env } = installEnv();
    const home = installedHome(env);
    sh(`LP_HOME="${home}"; update_check_cached`, { env: { ...env, LLAMAPAD_HUB_TAGS_URL: tagsFixture(["0.2.0"]) } });
    sh(`LP_HOME="${home}"; update_check_cached`, { env: { ...env, LLAMAPAD_HUB_TAGS_URL: tagsFixture(["0.3.0"]) } });
    expect(readFileSync(path.join(home, ".llamapad-state"), "utf8")).toContain("update_latest=0.2.0\n");
  });

  it("菜单头在有新版本时提示", () => {
    const { env } = installEnv();
    const home = installedHome(env);
    const r = sh(`LP_HOME="${home}"; docker_probe >/dev/null 2>&1; menu_header`, {
      env: { ...env, LLAMAPAD_HUB_TAGS_URL: tagsFixture(["0.2.0"]) },
    });
    expect(r.stderr).toContain("0.2.0");
  });
});

describe("self_update", () => {
  it("下载目标版本脚本，语法通过后替换并备份旧版", () => {
    const { env } = installEnv();
    const home = installedHome(env);
    writeFileSync(path.join(home, "llamapad.sh"), "echo old\n");
    const r = sh(`LP_HOME="${home}"; self_update 0.2.0`, {
      env: { ...env, LLAMAPAD_RAW_BASE: rawFixture({ "v0.2.0": "echo new\n" }) },
    });
    expect(r.code).toBe(0);
    expect(readFileSync(path.join(home, "llamapad.sh"), "utf8")).toBe("echo new\n");
    expect(readdirSync(path.join(home, "backups")).some((f) => f.startsWith("llamapad.sh."))).toBe(true);
  });

  it("下载内容语法错误时不替换", () => {
    const { env } = installEnv();
    const home = installedHome(env);
    writeFileSync(path.join(home, "llamapad.sh"), "echo old\n");
    const r = sh(`LP_HOME="${home}"; self_update 0.2.0`, {
      env: { ...env, LLAMAPAD_RAW_BASE: rawFixture({ "v0.2.0": "if then (\n" }) },
    });
    expect(r.code).toBe(1);
    expect(readFileSync(path.join(home, "llamapad.sh"), "utf8")).toBe("echo old\n");
  });
});

describe("template_sync", () => {
  it("与内嵌模板一致：不备份不改动", () => {
    const { env } = installEnv();
    const home = installedHome(env);
    sh(`LP_HOME="${home}"; template_sync`, { env });
    expect(readdirSync(path.join(home, "backups"))).toEqual([]);
  });

  it("旧模板且用户没改过：静默替换并备份", () => {
    const { env } = installEnv();
    const home = installedHome(env);
    const f = path.join(home, "docker-compose.yml");
    writeFileSync(f, "services: {}\n");
    sh(`LP_HOME="${home}"; state_set compose_sha256 "$(sha256_file "${f}")"; template_sync`, { env });
    expect(readFileSync(f, "utf8")).not.toBe("services: {}\n");
    expect(readdirSync(path.join(home, "backups")).some((x) => x.startsWith("docker-compose.yml."))).toBe(true);
  });

  it("用户手改过：展示差异并询问，拒绝则保留", () => {
    const { env } = installEnv();
    const home = installedHome(env);
    const f = path.join(home, "docker-compose.yml");
    writeFileSync(f, "services: {} # 我改的\n");
    const kept = sh(`LP_HOME="${home}"; template_sync`, { env, input: "n\n" });
    expect(kept.stderr).toContain("我改的");
    expect(readFileSync(f, "utf8")).toBe("services: {} # 我改的\n");
    sh(`LP_HOME="${home}"; template_sync`, { env, input: "y\n" });
    expect(readFileSync(f, "utf8")).not.toContain("我改的");
  });

  it("备份失败（backups 位置被同名文件占住）：不替换、报错、返回非零", () => {
    const { env } = installEnv();
    const home = installedHome(env);
    const f = path.join(home, "docker-compose.yml");
    writeFileSync(f, "services: {}\n");
    // apply_install 已建好 backups/ 目录；这里先删掉换成同名文件，让 mkdir -p 必然失败——
    // 与权限无关，比 chmod 只读更可靠（root 下 chmod 只读不生效）
    rmSync(path.join(home, "backups"), { recursive: true, force: true });
    writeFileSync(path.join(home, "backups"), "not-a-dir");
    const r = sh(`LP_HOME="${home}"; state_set compose_sha256 "$(sha256_file "${f}")"; template_sync`, { env });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("Failed to back up");
    expect(readFileSync(f, "utf8")).toBe("services: {}\n");
  });
});

describe("cmd_upgrade", () => {
  const upgrade = (to: string, input: string, extra: Record<string, string> = {}) => {
    const { env, log } = installEnv({ STUB_RUNNING: "true", ...extra });
    const home = installedHome(env);
    const r = sh(`LP_HOME="${home}"; OPT_TO=${to}; docker_probe >/dev/null 2>&1; cmd_upgrade`, {
      env: { ...env, LLAMAPAD_UPGRADE_STAGE: "2" },
      input,
    });
    return { r, home, log };
  };
  const version = (home: string) => /^LLAMAPAD_VERSION=(.*)$/m.exec(readFileSync(path.join(home, ".env"), "utf8"))?.[1];

  it("升级：改 LLAMAPAD_VERSION → pull → 强制重建", () => {
    const { r, home, log } = upgrade("0.2.0", "y\n");
    expect(r.code).toBe(0);
    expect(version(home)).toBe("0.2.0");
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain("docker compose pull");
    expect(calls).toContain("docker compose up -d --force-recreate");
  });

  it("pull 失败时回滚版本号", () => {
    const { r, home } = upgrade("0.2.0", "y\n", { STUB_PULL_EXIT: "1" });
    expect(r.code).toBe(1);
    expect(version(home)).toBe("0.1.0");
  });

  it("降级给出警告，默认不执行", () => {
    const { r, home } = upgrade("0.0.9", "\n");
    expect(r.stderr).toContain("Downgrading");
    expect(version(home)).toBe("0.1.0");
  });

  it("版本相同：只做模板检查，不 pull", () => {
    const { r, log } = upgrade("0.1.0", "");
    expect(r.code).toBe(0);
    expect(readFileSync(log, "utf8")).not.toContain("pull");
  });

  it("第一阶段：脚本版本与目标不同 → 自更新后以新脚本继续执行 upgrade", () => {
    const { env } = installEnv();
    const home = installedHome(env);
    writeFileSync(path.join(home, "llamapad.sh"), "echo old\n");
    const raw = rawFixture({ "v0.2.0": '#!/usr/bin/env bash\necho "reexec stage=$LLAMAPAD_UPGRADE_STAGE $*"\n' });
    const r = sh(`LP_HOME="${home}"; OPT_TO=0.2.0; cmd_upgrade`, { env: { ...env, LLAMAPAD_RAW_BASE: raw } });
    expect(r.stdout).toBe(`reexec stage=2 upgrade --to 0.2.0 --dir ${home} --lang en\n`);
    expect(existsSync(path.join(home, "backups"))).toBe(true);
  });

  it("未指定版本且查不到最新版：报错返回 1", () => {
    const { env } = installEnv();
    const home = installedHome(env);
    const r = sh(`LP_HOME="${home}"; cmd_upgrade`, { env });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--to");
  });

  it("template_sync 因备份失败中止：LLAMAPAD_VERSION 不被修改、不 pull", () => {
    const { env, log } = installEnv();
    const home = installedHome(env);
    const f = path.join(home, "docker-compose.yml");
    writeFileSync(f, "services: {}\n");
    rmSync(path.join(home, "backups"), { recursive: true, force: true });
    writeFileSync(path.join(home, "backups"), "not-a-dir");
    const r = sh(
      `LP_HOME="${home}"; OPT_TO=0.2.0; docker_probe >/dev/null 2>&1; state_set compose_sha256 "$(sha256_file "${f}")"; cmd_upgrade`,
      { env: { ...env, LLAMAPAD_UPGRADE_STAGE: "2" } },
    );
    expect(r.code).not.toBe(0);
    expect(version(home)).toBe("0.1.0");
    expect(readFileSync(log, "utf8")).not.toContain("pull");
  });
});
