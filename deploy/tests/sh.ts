import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** 被测脚本与相关目录 */
export const SCRIPT = path.resolve(__dirname, "../llamapad.sh");
export const DEPLOY_DIR = path.resolve(__dirname, "..");
export const REPO_ROOT = path.resolve(__dirname, "../..");
export const STUBS_DIR = path.resolve(__dirname, "fixtures/stubs");

export interface ShResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface ShOptions {
  env?: Record<string, string>;
  input?: string;
  cwd?: string;
}

/**
 * 测试默认环境：英文文案、无颜色、数字菜单、按键从 stdin 读、跳过 Linux 平台检查。
 * sudo 默认指向一个必然失败的路径——任何用例意外走到提权分支都会显式失败，而不是弹密码框。
 */
function baseEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LLAMAPAD_LANG: "en",
    NO_COLOR: "1",
    LLAMAPAD_PLAIN: "1",
    LLAMAPAD_TTY: "/dev/stdin",
    LLAMAPAD_SKIP_PLATFORM_CHECK: "1",
    LLAMAPAD_SUDO: "/nonexistent/sudo",
    LLAMAPAD_HOME: "",
    ...extra,
  };
}

/** source 脚本（LLAMAPAD_SOURCE_ONLY=1，只定义函数不跑 main）后执行 body */
export function sh(body: string, opts: ShOptions = {}): ShResult {
  const r = spawnSync("bash", ["-c", `source "$LP_TEST_SCRIPT"\n${body}`], {
    encoding: "utf8",
    input: opts.input ?? "",
    cwd: opts.cwd,
    env: baseEnv({ LP_TEST_SCRIPT: SCRIPT, LLAMAPAD_SOURCE_ONLY: "1", ...opts.env }),
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** 以真实入口执行脚本（走 main） */
export function runScript(args: string[], opts: ShOptions = {}): ShResult {
  const r = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    input: opts.input ?? "",
    cwd: opts.cwd,
    env: baseEnv(opts.env),
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** 真实路径的临时目录（macOS 的 tmpdir 经过 /var → /private/var 符号链接，统一解析掉） */
export function tempDir(prefix = "lp-sh-"): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
}

/** 建一个 bin 目录，放入 fixtures/stubs 下指定的桩命令；返回该目录 */
export function stubBin(...names: string[]): string {
  const bin = path.join(tempDir("lp-bin-"), "bin");
  mkdirSync(bin, { recursive: true });
  for (const name of names) {
    const dst = path.join(bin, name);
    copyFileSync(path.join(STUBS_DIR, name), dst);
    chmodSync(dst, 0o755);
  }
  return bin;
}

/** 把 bin 目录拼到 PATH 最前面 */
export function pathWith(bin: string): string {
  return `${bin}:${process.env.PATH ?? ""}`;
}
