import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** 被测脚本与相关目录 */
export const SCRIPT = path.resolve(__dirname, "../llamapad.sh");
export const DEPLOY_DIR = path.resolve(__dirname, "..");
export const REPO_ROOT = path.resolve(__dirname, "../..");
export const STUBS_DIR = path.resolve(__dirname, "fixtures/stubs");

/**
 * 子进程默认工作目录：本仓库根目录本身含 Dockerfile 与 name=llamapad 的 package.json，
 * 是 repo_detect 意义上的「仓库」。spawnSync 不传 cwd 时会继承 vitest 进程的 cwd（即仓库根），
 * 这会让所有未显式设置 cwd 的用例意外触发仓库检测（wizard 多出「从当前仓库构建」选项、
 * main_menu 多出「构建镜像」项……），与用例本身要测的东西无关。默认改指向一个保证不是仓库的
 * 空目录，只有 image.test.ts 里测仓库检测/构建的用例才需要显式传 cwd 指到仓库或桩仓库。
 */
const NON_REPO_CWD = realpathSync(mkdtempSync(path.join(tmpdir(), "lp-cwd-")));

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
 *
 * LLAMAPAD_TTY 走 `-`（沿用继承的 stdin）而不是 /dev/stdin：spawnSync 喂完 input 立刻关掉
 * 管道写端，Linux 上再 open /dev/stdin（即 /proc/self/fd/0）就是 ENXIO，脚本一个键都读不到。
 */
function baseEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LLAMAPAD_LANG: "en",
    NO_COLOR: "1",
    LLAMAPAD_PLAIN: "1",
    LLAMAPAD_TTY: "-",
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
    cwd: opts.cwd ?? NON_REPO_CWD,
    env: baseEnv({ LP_TEST_SCRIPT: SCRIPT, LLAMAPAD_SOURCE_ONLY: "1", ...opts.env }),
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** 以真实入口执行脚本（走 main） */
export function runScript(args: string[], opts: ShOptions = {}): ShResult {
  const r = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    input: opts.input ?? "",
    cwd: opts.cwd ?? NON_REPO_CWD,
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

/**
 * 一套可跑完整安装流程的桩环境：docker / df / ss / hostname / timedatectl / curl 走桩，
 * 单块根盘、无 GPU、时区 Asia/Shanghai、docker.sock 为普通文件、命令入口写到临时 bin。
 */
export function installEnv(extra: Record<string, string> = {}) {
  const bin = stubBin("docker", "df", "ss", "hostname", "timedatectl", "curl");
  const root = tempDir("lp-env-");
  const log = path.join(root, "calls.log");
  const proc = path.join(root, "proc");
  const etc = path.join(root, "etc");
  const launcherDir = path.join(root, "usr-local-bin");
  mkdirSync(proc);
  mkdirSync(etc);
  mkdirSync(launcherDir);
  writeFileSync(log, "");
  writeFileSync(path.join(proc, "mounts"), "/dev/sda1 / ext4 rw 0 0\n");
  writeFileSync(path.join(root, "df.tsv"), "/\t500000000\n");
  writeFileSync(path.join(etc, "timezone"), "Asia/Shanghai\n");
  writeFileSync(path.join(root, "docker.sock"), "");
  return {
    root,
    log,
    launcherDir,
    env: {
      PATH: pathWith(bin),
      STUB_LOG: log,
      STUB_DF_TABLE: path.join(root, "df.tsv"),
      STUB_IPS: "192.168.1.20",
      LLAMAPAD_PROC: proc,
      LLAMAPAD_SYSFS: path.join(root, "sys"),
      LLAMAPAD_ETC: etc,
      LLAMAPAD_DOCKER_SOCK: path.join(root, "docker.sock"),
      LLAMAPAD_NVIDIA_SMI: "/nonexistent/nvidia-smi",
      LLAMAPAD_BIN_DIR: launcherDir,
      LLAMAPAD_READY_TIMEOUT: "1",
      // 版本检查与脚本下载指向不存在的本地地址：测试绝不访问外网
      LLAMAPAD_HUB_TAGS_URL: "file:///nonexistent/tags.json",
      LLAMAPAD_RAW_BASE: "file:///nonexistent",
      ...extra,
    },
  };
}

/** 用 apply_install 造一个已安装的部署目录（运行身份取当前用户，不触发 chown 提权） */
export function installedHome(env: Record<string, string>, opts: { gpu?: 0 | 1; dockerGid?: string } = {}): string {
  const home = tempDir("lp-home-");
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  const r = sh(
    `LP_HOME="${home}"; wizard_defaults
W_DOCKER_GID=${opts.dockerGid ?? "984"} W_PUID=${uid} W_PGID=${gid} W_GPU=${opts.gpu ?? 0}
W_MODELS_DIR=./models W_MODELS_NEW=1 W_PASSWORD=initial-pass-1 W_TZ=Asia/Shanghai
apply_install`,
    { env },
  );
  if (r.code !== 0) throw new Error(`installedHome 失败：${r.stderr}`);
  return home;
}
