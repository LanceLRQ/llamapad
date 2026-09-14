import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { SCRIPT, installEnv, installedHome, pathWith, runScript, sh, stubBin, tempDir } from "./sh";

// 每条用例都会 fork bash 并 source 整个脚本，全量并行跑多个测试文件时进程调度可能让
// 单条用例超过 vitest 默认的 5s，故本文件整体调宽超时（不改 vitest.config.ts）
vi.setConfig({ testTimeout: 30_000 });

describe("目录状态与部署目录判定", () => {
  it("dir_state：有 state 为 installed；有 compose 或 .env 为 adopt；其余 empty", () => {
    const state = (setup: (d: string) => void) => {
      const d = tempDir();
      setup(d);
      return sh(`dir_state "${d}"`).stdout;
    };
    expect(state(() => {})).toBe("empty");
    expect(state((d) => writeFileSync(path.join(d, ".env"), ""))).toBe("adopt");
    expect(state((d) => writeFileSync(path.join(d, "docker-compose.yml"), ""))).toBe("adopt");
    expect(
      state((d) => {
        writeFileSync(path.join(d, ".env"), "");
        writeFileSync(path.join(d, ".llamapad-state"), "");
      }),
    ).toBe("installed");
    expect(sh('dir_state "/nonexistent/lp-dir"').stdout).toBe("empty");
  });

  it("home_candidate：--dir > LLAMAPAD_HOME > 脚本所在目录", () => {
    expect(sh('OPT_DIR=/a; home_candidate', { env: { LLAMAPAD_HOME: "/b" } }).stdout).toBe("/a");
    expect(sh("home_candidate", { env: { LLAMAPAD_HOME: "/b" } }).stdout).toBe("/b");
    expect(sh("home_candidate").stdout).toBe(path.dirname(SCRIPT));
  });
});

describe("命令入口", () => {
  it("launcher_content 生成的启动器从任意目录都作用于安装目录并透传参数", () => {
    const home = tempDir();
    writeFileSync(path.join(home, "llamapad.sh"), '#!/bin/sh\necho "$LLAMAPAD_HOME|$*"\n');
    chmodSync(path.join(home, "llamapad.sh"), 0o755);
    const launcher = path.join(tempDir(), "llamapad");
    writeFileSync(launcher, sh(`launcher_content "${home}"`).stdout, { mode: 0o755 });
    const r = spawnSync("sh", [launcher, "status", "--lang", "zh"], { encoding: "utf8", cwd: "/" });
    expect(r.stdout.trim()).toBe(`${home}|status --lang zh`);
  });

  it("install_launcher 写入可执行启动器；已存在且指向别处时询问，拒绝则保留原文件", () => {
    const home = tempDir();
    const bin = tempDir();
    const env = { LLAMAPAD_BIN_DIR: bin };
    expect(sh(`install_launcher "${home}"`, { env }).code).toBe(0);
    const dst = path.join(bin, "llamapad");
    expect(readFileSync(dst, "utf8")).toContain(`${home}/llamapad.sh`);
    expect(statSync(dst).mode & 0o111).not.toBe(0);

    writeFileSync(dst, "#!/bin/sh\nexec /other/llamapad.sh\n");
    sh(`install_launcher "${home}"`, { env, input: "n\n" });
    expect(readFileSync(dst, "utf8")).toContain("/other/llamapad.sh");
    sh(`install_launcher "${home}"`, { env, input: "y\n" });
    expect(readFileSync(dst, "utf8")).toContain(`${home}/llamapad.sh`);
  });

  it("命令入口目录需要 sudo 时用 install 落地而非 mv（mv 是 rename，不会把属主改成 root）", () => {
    const home = tempDir();
    // LP_BIN_DIR 尚不存在（其父目录可写）：[ -d ] 为假，必然走 sudo 分支；
    // sudo 桩直接透传执行，父目录本就可写，所以整条链路在测试里也能真正落盘
    const bin = path.join(tempDir(), "not-yet-created");
    const sudoDir = stubBin("sudo");
    const log = path.join(tempDir(), "calls.log");
    writeFileSync(log, "");
    const env = {
      LLAMAPAD_BIN_DIR: bin,
      LLAMAPAD_SUDO: path.join(sudoDir, "sudo"),
      PATH: pathWith(sudoDir),
      STUB_LOG: log,
    };
    const r = sh(`install_launcher "${home}"`, { env, input: "y\n" });
    expect(r.code).toBe(0);
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain("sudo install -m 755");
    expect(calls).not.toContain("sudo mv");
    expect(readFileSync(path.join(bin, "llamapad"), "utf8")).toContain(`${home}/llamapad.sh`);
    expect(existsSync(path.join(home, ".llamapad-launcher.tmp"))).toBe(false);
  });
});

describe("放置脚本本体", () => {
  it("从真实文件运行时复制自身", () => {
    const home = tempDir();
    expect(sh(`place_self "${home}"`).code).toBe(0);
    expect(readFileSync(path.join(home, "llamapad.sh"), "utf8")).toBe(readFileSync(SCRIPT, "utf8"));
    expect(statSync(path.join(home, "llamapad.sh")).mode & 0o111).not.toBe(0);
  });

  it("管道运行（LP_SELF 为空）时按版本 tag 下载，tag 不存在回退 main；语法错误的下载不落盘", () => {
    const raw = tempDir();
    const put = (ref: string, body: string) => {
      mkdirSync(path.join(raw, ref, "deploy"), { recursive: true });
      writeFileSync(path.join(raw, ref, "deploy/llamapad.sh"), body);
    };
    const env = { LLAMAPAD_RAW_BASE: `file://${raw}` };

    put("main", "echo from-main\n");
    const h1 = tempDir();
    expect(sh(`LP_SELF=""; place_self "${h1}"`, { env }).code).toBe(0);
    expect(readFileSync(path.join(h1, "llamapad.sh"), "utf8")).toBe("echo from-main\n");

    put("v0.1.0", "echo from-tag\n");
    const h2 = tempDir();
    sh(`LP_SELF=""; place_self "${h2}"`, { env });
    expect(readFileSync(path.join(h2, "llamapad.sh"), "utf8")).toBe("echo from-tag\n");

    put("v0.1.0", "if then fi (\n");
    const h3 = tempDir();
    expect(sh(`LP_SELF=""; place_self "${h3}"`, { env }).code).toBe(1);
    expect(existsSync(path.join(h3, "llamapad.sh"))).toBe(false);
  });

  it("ensure_dir_writable 创建不存在的目录", () => {
    const d = path.join(tempDir(), "a/b");
    expect(sh(`ensure_dir_writable "${d}"`).code).toBe(0);
    expect(existsSync(d)).toBe(true);
  });
});

describe("main 分发", () => {
  it("仓库里的 deploy/ 不会被当成已安装目录：管理命令提示未安装并返回 1", () => {
    const r = runScript(["status"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not installed");
  });

  it("已安装目录下未知命令返回 2", () => {
    const home = tempDir();
    writeFileSync(path.join(home, ".llamapad-state"), "template_version=1\n");
    expect(runScript(["frobnicate"], { env: { LLAMAPAD_HOME: home } }).code).toBe(2);
  });

  it("非 Linux 且未设跳过变量时拒绝安装", () => {
    if (process.platform === "linux") return;
    const r = runScript(["install"], { env: { LLAMAPAD_SKIP_PLATFORM_CHECK: "" } });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Linux");
  });
});

describe("管理模式权限检查", () => {
  // root 下 [ -w ] 恒真，这组用例验证的是「非 root 用户碰到别人部署」的场景，root 下无意义、会误报
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

  it.skipIf(isRoot)("部署目录不可写时拒绝进入管理模式，提示用 sudo", () => {
    const { env } = installEnv();
    const home = installedHome(env);
    chmodSync(home, 0o555);
    try {
      const r = runScript(["status"], { env: { ...env, LLAMAPAD_HOME: home } });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("sudo llamapad");
    } finally {
      chmodSync(home, 0o755);
    }
  });

  it.skipIf(isRoot)(".env 存在但不可读写时拒绝进入管理模式", () => {
    const { env } = installEnv();
    const home = installedHome(env);
    const envFile = path.join(home, ".env");
    chmodSync(envFile, 0o000);
    try {
      const r = runScript(["status"], { env: { ...env, LLAMAPAD_HOME: home } });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("sudo llamapad");
    } finally {
      chmodSync(envFile, 0o600);
    }
  });

  it.skipIf(isRoot)("help 与 version 不受目录权限影响", () => {
    const { env } = installEnv();
    const home = installedHome(env);
    chmodSync(home, 0o555);
    try {
      expect(runScript(["help"], { env: { ...env, LLAMAPAD_HOME: home } }).code).toBe(0);
      expect(runScript(["version"], { env: { ...env, LLAMAPAD_HOME: home } }).code).toBe(0);
    } finally {
      chmodSync(home, 0o755);
    }
  });

  // main() 对「已安装且已知目录」的权限检查在 home_candidate() 能直接解析出
  // home 时才生效；不设 LLAMAPAD_HOME 时 cmd_install 自己在向导第一步问安装目录，用户
  // 键入的目录判定为已安装（st=installed）后走的是另一条分支，此前没做同样的权限检查
  it.skipIf(isRoot)("cmd_install 判定目标目录已安装但无权限时同样拒绝，不进入管理菜单", () => {
    const { env } = installEnv();
    const home = installedHome(env);
    chmodSync(home, 0o555);
    try {
      const r = runScript([], { env, input: `${home}\n` });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("sudo llamapad");
    } finally {
      chmodSync(home, 0o755);
    }
  });
});
