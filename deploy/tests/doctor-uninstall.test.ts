import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { installEnv, installedHome, sh, tempDir } from "./sh";

// 每条用例都会 fork bash 并 source 整个脚本，全量并行跑多个测试文件时进程调度可能让
// 单条用例超过 vitest 默认的 5s，故本文件整体调宽超时（不改 vitest.config.ts）
vi.setConfig({ testTimeout: 30_000 });

const sockGid = (env: Record<string, string>) => String(statSync(env.LLAMAPAD_DOCKER_SOCK!).gid);

describe("cmd_doctor", () => {
  it("一切正常：全部 ✔，退出码 0", () => {
    const { env } = installEnv();
    const home = installedHome(env, { dockerGid: sockGid(env) });
    const r = sh(`LP_HOME="${home}"; cmd_doctor`, { env });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("All checks passed");
    expect(r.stderr).not.toContain("✘");
  });

  it("DOCKER_GID 与 sock 不一致只是警告（start 会自动修正）", () => {
    const { env } = installEnv();
    const home = installedHome(env, { dockerGid: "1" });
    const r = sh(`LP_HOME="${home}"; cmd_doctor`, { env });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("⚠");
    expect(r.stderr).toContain("llamapad start");
  });

  it(".env 缺必填项、docker 不可用都算失败，退出码 1", () => {
    const { env } = installEnv();
    const home = installedHome(env, { dockerGid: sockGid(env) });
    const envFile = path.join(home, ".env");
    writeFileSync(envFile, readFileSync(envFile, "utf8").replace(/^DOCKER_GID=.*\n/m, ""));
    const r = sh(`LP_HOME="${home}"; cmd_doctor`, { env: { ...env, LLAMAPAD_DOCKER_BIN: "/nonexistent/docker" } });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("DOCKER_GID");
    expect(r.stderr).toContain("docs.docker.com");
  });

  it("有显卡但未启用 GPU：警告并提示用 config 开启", () => {
    const { env } = installEnv({
      LLAMAPAD_NVIDIA_SMI: path.join(__dirname, "fixtures/stubs/nvidia-smi"),
      STUB_GPUS: "GPU 0: RTX 3090 (UUID: GPU-1)\\n",
    });
    const home = installedHome(env, { dockerGid: sockGid(env) });
    const r = sh(`LP_HOME="${home}"; cmd_doctor`, { env });
    expect(r.stderr).toContain("llamapad config");
  });

  it("compose 被手改：警告", () => {
    const { env } = installEnv();
    const home = installedHome(env, { dockerGid: sockGid(env) });
    writeFileSync(path.join(home, "docker-compose.yml"), "services: {}\n");
    expect(sh(`LP_HOME="${home}"; cmd_doctor`, { env }).stderr).toContain("edited");
  });
});

describe("cmd_uninstall", () => {
  function setup() {
    const { env, log, launcherDir } = installEnv();
    const home = installedHome(env);
    const outsideModels = path.join(tempDir(), "models-outside");
    mkdirSync(outsideModels);
    writeFileSync(path.join(outsideModels, "keep.gguf"), "x");
    sh(`LP_HOME="${home}"; env_set "${home}/.env" MODELS_DIR "${outsideModels}"; install_launcher "${home}"`, { env });
    return { env, log, launcherDir, home, outsideModels };
  }
  const uninstall = (s: ReturnType<typeof setup>, input: string) =>
    sh(`LP_HOME="${s.home}"; docker_probe >/dev/null 2>&1; cmd_uninstall`, { env: s.env, input });

  it("默认保留安装目录：down 容器、移除指向本目录的命令入口", () => {
    const s = setup();
    expect(uninstall(s, "y\nn\n").code).toBe(0);
    expect(readFileSync(s.log, "utf8")).toContain("docker compose down");
    expect(existsSync(path.join(s.launcherDir, "llamapad"))).toBe(false);
    expect(existsSync(s.home)).toBe(true);
  });

  it("询问删除前列出安装目录里不属于 llamapad 的顶层内容", () => {
    const s = setup();
    writeFileSync(path.join(s.home, "notes.txt"), "手工加的备忘");
    mkdirSync(path.join(s.home, "extra-dir"));
    const r = uninstall(s, "y\ny\nwrong-name\n");
    expect(r.stderr).toContain("notes.txt");
    expect(r.stderr).toContain("extra-dir");
    // llamapad 自身产物（data/、docker-compose.yml 等）不应被当成「不属于 llamapad」列出来
    expect(r.stderr).not.toContain("    data\n");
    expect(r.stderr).not.toContain("    docker-compose.yml\n");
  });

  it("删除安装目录须输入目录名；输错不删", () => {
    const s = setup();
    uninstall(s, "y\ny\nwrong-name\n");
    expect(existsSync(s.home)).toBe(true);
  });

  it("输入正确目录名删除安装目录，安装目录之外的模型库保留", () => {
    const s = setup();
    uninstall(s, `y\ny\n${path.basename(s.home)}\n`);
    expect(existsSync(s.home)).toBe(false);
    expect(existsSync(path.join(s.outsideModels, "keep.gguf"))).toBe(true);
  });

  it("命令入口指向其他安装时不删", () => {
    const s = setup();
    writeFileSync(path.join(s.launcherDir, "llamapad"), "#!/bin/sh\nexec /other/llamapad.sh\n");
    uninstall(s, "y\nn\n");
    expect(existsSync(path.join(s.launcherDir, "llamapad"))).toBe(true);
  });

  it("取消卸载什么都不做", () => {
    const s = setup();
    expect(uninstall(s, "n\n").code).toBe(1);
    expect(readFileSync(s.log, "utf8")).not.toContain("down");
  });

  it("safe_remove_home 拒绝删除没有 state 文件的目录与系统目录", () => {
    const d = tempDir();
    expect(sh(`LP_HOME="${d}"; safe_remove_home`).code).toBe(1);
    expect(existsSync(d)).toBe(true);
    expect(sh('LP_HOME=/usr; safe_remove_home').code).toBe(1);
  });
});
