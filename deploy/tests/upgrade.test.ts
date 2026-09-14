import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { installEnv, installedHome, runScript, sh, tempDir } from "./sh";

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
  it("下载目标版本脚本，语法通过且版本号匹配后替换并备份旧版", () => {
    const { env } = installEnv();
    const home = installedHome(env);
    writeFileSync(path.join(home, "llamapad.sh"), "echo old\n");
    const body = '#!/usr/bin/env bash\nLLAMAPAD_SCRIPT_VERSION="0.2.0"\necho new\n';
    const r = sh(`LP_HOME="${home}"; self_update 0.2.0`, {
      env: { ...env, LLAMAPAD_RAW_BASE: rawFixture({ "v0.2.0": body }) },
    });
    expect(r.code).toBe(0);
    expect(readFileSync(path.join(home, "llamapad.sh"), "utf8")).toBe(body);
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

  it("下载内容语法合法但版本号不符时不替换（防止误判合法脚本就是目标版本）", () => {
    const { env } = installEnv();
    const home = installedHome(env);
    writeFileSync(path.join(home, "llamapad.sh"), "echo old\n");
    const body = '#!/usr/bin/env bash\nLLAMAPAD_SCRIPT_VERSION="0.1.9"\necho new\n';
    const r = sh(`LP_HOME="${home}"; self_update 0.2.0`, {
      env: { ...env, LLAMAPAD_RAW_BASE: rawFixture({ "v0.2.0": body }) },
    });
    expect(r.code).toBe(1);
    expect(readFileSync(path.join(home, "llamapad.sh"), "utf8")).toBe("echo old\n");
    expect(existsSync(path.join(home, ".llamapad.sh.new"))).toBe(false);
  });

  it("备份目录建不起来（同名文件占位）：中止且清理下载的临时文件", () => {
    const { env } = installEnv();
    const home = installedHome(env);
    writeFileSync(path.join(home, "llamapad.sh"), "echo old\n");
    rmSync(path.join(home, "backups"), { recursive: true, force: true });
    writeFileSync(path.join(home, "backups"), "not-a-dir");
    const body = '#!/usr/bin/env bash\nLLAMAPAD_SCRIPT_VERSION="0.2.0"\necho new\n';
    const r = sh(`LP_HOME="${home}"; self_update 0.2.0`, {
      env: { ...env, LLAMAPAD_RAW_BASE: rawFixture({ "v0.2.0": body }) },
    });
    expect(r.code).not.toBe(0);
    expect(readFileSync(path.join(home, "llamapad.sh"), "utf8")).toBe("echo old\n");
    expect(existsSync(path.join(home, ".llamapad.sh.new"))).toBe(false);
  });
});

describe("template_sync", () => {
  // apply_install 建目录时已把 template_version 写到当前 LLAMAPAD_TEMPLATE_VERSION（=1）；
  // F3 裁定「只在内嵌模板版本变大时处理」，这里的用例要验证的是「版本变大」这条路径，
  // 所以统一先把 state 里的 template_version 调低，制造出「版本落后，需要检查」的前提
  const outdate = (home: string) => sh(`LP_HOME="${home}"; state_set template_version 0`, { env: {} });

  it("与内嵌模板一致：不备份不改动", () => {
    const { env } = installEnv();
    const home = installedHome(env);
    sh(`LP_HOME="${home}"; template_sync`, { env });
    expect(readdirSync(path.join(home, "backups"))).toEqual([]);
  });

  it("模板版本未变大：已存在的文件直接跳过，不比对校验和也不弹询问", () => {
    const { env } = installEnv();
    const home = installedHome(env);
    const f = path.join(home, "docker-compose.yml");
    writeFileSync(f, "services: {} # 我改的\n");
    // 不下调 template_version：保持与安装时相同的版本号，属于「版本未变大」
    const r = sh(`LP_HOME="${home}"; template_sync`, { env });
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain("我改的");
    expect(readFileSync(f, "utf8")).toBe("services: {} # 我改的\n");
    expect(readdirSync(path.join(home, "backups"))).toEqual([]);
  });

  it("旧模板且用户没改过：静默替换并备份", () => {
    const { env } = installEnv();
    const home = installedHome(env);
    const f = path.join(home, "docker-compose.yml");
    writeFileSync(f, "services: {}\n");
    sh(`LP_HOME="${home}"; state_set compose_sha256 "$(sha256_file "${f}")"; state_set template_version 0; template_sync`, {
      env,
    });
    expect(readFileSync(f, "utf8")).not.toBe("services: {}\n");
    expect(readdirSync(path.join(home, "backups")).some((x) => x.startsWith("docker-compose.yml."))).toBe(true);
  });

  it("用户手改过：展示差异并询问，拒绝则保留", () => {
    const { env } = installEnv();
    const home = installedHome(env);
    const f = path.join(home, "docker-compose.yml");
    writeFileSync(f, "services: {} # 我改的\n");
    outdate(home);
    const kept = sh(`LP_HOME="${home}"; template_sync`, { env, input: "n\n" });
    expect(kept.stderr).toContain("我改的");
    expect(readFileSync(f, "utf8")).toBe("services: {} # 我改的\n");
    outdate(home);
    sh(`LP_HOME="${home}"; template_sync`, { env, input: "y\n" });
    expect(readFileSync(f, "utf8")).not.toContain("我改的");
  });

  it("版本变大且手改过时一路回车（默认）保留原文件", () => {
    const { env } = installEnv();
    const home = installedHome(env);
    const f = path.join(home, "docker-compose.yml");
    writeFileSync(f, "services: {} # 我改的\n");
    outdate(home);
    const r = sh(`LP_HOME="${home}"; template_sync`, { env, input: "\n" });
    expect(r.stderr).toContain("我改的");
    expect(readFileSync(f, "utf8")).toBe("services: {} # 我改的\n");
    // 一路回车即用了默认值（保留），但仍算「走完了检查」：template_version 照样推进，
    // 不会在没有新版模板之前反复用同一版本号纠缠用户
    expect(readFileSync(path.join(home, ".llamapad-state"), "utf8")).toContain("template_version=1\n");
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
    const r = sh(
      `LP_HOME="${home}"; state_set compose_sha256 "$(sha256_file "${f}")"; state_set template_version 0; template_sync`,
      { env },
    );
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

  it("pull 失败时不仅回滚版本号，本次 template_sync 静默替换过的模板文件也一并恢复", () => {
    const { env, log } = installEnv({ STUB_RUNNING: "true", STUB_PULL_EXIT: "1" });
    const home = installedHome(env);
    const f = path.join(home, "docker-compose.yml");
    const oldContent = "services: {} # old\n";
    writeFileSync(f, oldContent);
    const oldSha = sh(`sha256_file "${f}"`, { env }).stdout.trim();
    // 旧校验和与磁盘内容一致：代表「用户没手改过」，模板版本变大后 template_sync 会静默替换它
    sh(`LP_HOME="${home}"; state_set compose_sha256 "${oldSha}"; state_set template_version 0`, { env });
    const r = sh(`LP_HOME="${home}"; OPT_TO=0.2.0; docker_probe >/dev/null 2>&1; cmd_upgrade`, {
      env: { ...env, LLAMAPAD_UPGRADE_STAGE: "2" },
      input: "y\n",
    });
    expect(r.code).not.toBe(0);
    expect(version(home)).toBe("0.1.0");
    expect(readFileSync(f, "utf8")).toBe(oldContent);
    const state = readFileSync(path.join(home, ".llamapad-state"), "utf8");
    expect(state).toContain(`compose_sha256=${oldSha}\n`);
    expect(state).toContain("template_version=0\n");
    expect(readFileSync(log, "utf8")).toContain("docker compose pull");
  });

  it("拒绝升级：脚本、模板、版本号都不变，返回 0", () => {
    const { r, home } = upgrade("0.2.0", "n\n");
    expect(r.code).toBe(0);
    expect(version(home)).toBe("0.1.0");
  });

  it("降级给出警告，默认不执行，未发生自更新（下载脚本用的 curl 未被调用）", () => {
    const { r, home, log } = upgrade("0.0.9", "\n");
    expect(r.stderr).toContain("Downgrading");
    expect(version(home)).toBe("0.1.0");
    expect(readFileSync(log, "utf8")).not.toContain("curl");
  });

  it("版本相同：只做模板检查，不 pull", () => {
    const { r, log } = upgrade("0.1.0", "");
    expect(r.code).toBe(0);
    expect(readFileSync(log, "utf8")).not.toContain("pull");
  });

  it("第一阶段：确认升级后才自更新，再以新脚本继续执行 upgrade（带上 CONFIRMED）", () => {
    const { env } = installEnv();
    const home = installedHome(env);
    writeFileSync(path.join(home, "llamapad.sh"), "echo old\n");
    const body =
      '#!/usr/bin/env bash\nLLAMAPAD_SCRIPT_VERSION="0.2.0"\necho "reexec stage=$LLAMAPAD_UPGRADE_STAGE confirmed=$LLAMAPAD_UPGRADE_CONFIRMED $*"\n';
    const raw = rawFixture({ "v0.2.0": body });
    // 目标 0.2.0 > 当前镜像版本 0.1.0：先要经过「确认升级」（默认是，回车即可），
    // F1 修复前旧代码在这一步之前就已经自更新完毕——这条用例正是锁住「确认先于自更新」这条裁定
    const r = sh(`LP_HOME="${home}"; OPT_TO=0.2.0; cmd_upgrade`, { env: { ...env, LLAMAPAD_RAW_BASE: raw }, input: "\n" });
    expect(r.stdout).toBe(`reexec stage=2 confirmed=1 upgrade --to 0.2.0 --dir ${home} --lang en\n`);
    expect(existsSync(path.join(home, "backups"))).toBe(true);
  });

  it("第一阶段：拒绝升级时不会自更新（脚本文件原样未变）", () => {
    const { env } = installEnv();
    const home = installedHome(env);
    writeFileSync(path.join(home, "llamapad.sh"), "echo old\n");
    const raw = rawFixture({ "v0.2.0": '#!/usr/bin/env bash\nLLAMAPAD_SCRIPT_VERSION="0.2.0"\necho reexec\n' });
    const r = sh(`LP_HOME="${home}"; OPT_TO=0.2.0; cmd_upgrade`, { env: { ...env, LLAMAPAD_RAW_BASE: raw }, input: "n\n" });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(readFileSync(path.join(home, "llamapad.sh"), "utf8")).toBe("echo old\n");
    // backups/ 目录本就由安装流程建好；这里断言的是没有新增任何备份文件，而不是目录本身不存在
    expect(readdirSync(path.join(home, "backups"))).toEqual([]);
  });

  it("真实入口走第二阶段：--to/--dir/--lang 与 STAGE=2/CONFIRMED=1 这组跨版本接口按预期落地", () => {
    const { env, log } = installEnv({ STUB_RUNNING: "true" });
    const home = installedHome(env);
    const r = runScript(["upgrade", "--to", "0.2.0", "--dir", home, "--lang", "zh"], {
      env: { ...env, LLAMAPAD_UPGRADE_STAGE: "2", LLAMAPAD_UPGRADE_CONFIRMED: "1" },
    });
    expect(r.code).toBe(0);
    expect(version(home)).toBe("0.2.0");
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain("docker compose pull");
    expect(calls).toContain("docker compose up -d --force-recreate");
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
      `LP_HOME="${home}"; OPT_TO=0.2.0; docker_probe >/dev/null 2>&1
state_set compose_sha256 "$(sha256_file "${f}")"; state_set template_version 0
cmd_upgrade`,
      { env: { ...env, LLAMAPAD_UPGRADE_STAGE: "2" }, input: "y\n" },
    );
    expect(r.code).not.toBe(0);
    expect(version(home)).toBe("0.1.0");
    expect(readFileSync(log, "utf8")).not.toContain("pull");
  });
});

describe("cmd_upgrade：自更新失败降级为仅升级镜像", () => {
  const version = (home: string) => /^LLAMAPAD_VERSION=(.*)$/m.exec(readFileSync(path.join(home, ".env"), "utf8"))?.[1];

  it("同意仅升级镜像：版本号改为 target 且 pull 被调用，脚本文件未被替换", () => {
    // installEnv 默认的 LLAMAPAD_RAW_BASE 指向不存在的本地地址，self_update 必然下载失败
    const { env, log } = installEnv({ STUB_RUNNING: "true" });
    const home = installedHome(env);
    writeFileSync(path.join(home, "llamapad.sh"), "echo old\n");
    const r = sh(`LP_HOME="${home}"; OPT_TO=0.2.0; docker_probe >/dev/null 2>&1; cmd_upgrade`, {
      env,
      input: "y\ny\n", // 先确认升级，再同意「仅升级镜像」
    });
    expect(r.code).toBe(0);
    expect(version(home)).toBe("0.2.0");
    expect(readFileSync(log, "utf8")).toContain("docker compose pull");
    expect(readFileSync(path.join(home, "llamapad.sh"), "utf8")).toBe("echo old\n");
  });

  it("拒绝仅升级镜像：返回非零且什么都不改", () => {
    const { env, log } = installEnv();
    const home = installedHome(env);
    writeFileSync(path.join(home, "llamapad.sh"), "echo old\n");
    const r = sh(`LP_HOME="${home}"; OPT_TO=0.2.0; docker_probe >/dev/null 2>&1; cmd_upgrade`, {
      env,
      input: "y\nn\n",
    });
    expect(r.code).toBe(1);
    expect(version(home)).toBe("0.1.0");
    expect(readFileSync(log, "utf8")).not.toContain("pull");
    expect(readFileSync(path.join(home, "llamapad.sh"), "utf8")).toBe("echo old\n");
  });
});
