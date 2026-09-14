import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { SCRIPT, runScript, sh, tempDir } from "./sh";

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
