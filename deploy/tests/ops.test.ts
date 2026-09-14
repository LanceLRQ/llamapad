import { readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { installEnv, installedHome, runScript, sh } from "./sh";

// 每条用例都会 fork bash 并 source 整个脚本，全量并行跑多个测试文件时进程调度可能让
// 单条用例超过 vitest 默认的 5s，故本文件整体调宽超时（不改 vitest.config.ts）
vi.setConfig({ testTimeout: 30_000 });

const run = (home: string, body: string, env: Record<string, string>, input = "") =>
  sh(`LP_HOME="${home}"; docker_probe >/dev/null 2>&1; ${body}`, { env, input });

describe("start / restart", () => {
  it("启动前把 DOCKER_GID 同步为 sock 的实际 gid，up -d 后等待就绪并打印地址", () => {
    const { env, log } = installEnv();
    const home = installedHome(env, { dockerGid: "1" });
    const r = run(home, "cmd_start", env);
    expect(r.code).toBe(0);
    const sockGid = String(statSync(env.LLAMAPAD_DOCKER_SOCK).gid);
    expect(readFileSync(path.join(home, ".env"), "utf8")).toContain(`DOCKER_GID=${sockGid}\n`);
    expect(readFileSync(log, "utf8")).toContain("docker compose up -d");
    expect(r.stderr).toContain("http://127.0.0.1:28960");
  });

  it("端口被其他程序占用时拒绝启动", () => {
    const { env, log } = installEnv({ STUB_SS: "State Recv-Q Send-Q Local Address:Port Peer\\nLISTEN 0 1 0.0.0.0:28960 0.0.0.0:*\\n" });
    const home = installedHome(env);
    const r = run(home, "cmd_start", env);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("28960");
    expect(readFileSync(log, "utf8")).not.toContain("compose up");
  });

  it("面板自己正在运行时不做端口检查", () => {
    const { env } = installEnv({
      STUB_RUNNING: "true",
      STUB_SS: "State Recv-Q Send-Q Local Address:Port Peer\\nLISTEN 0 1 0.0.0.0:28960 0.0.0.0:*\\n",
    });
    expect(run(installedHome(env), "cmd_start", env).code).toBe(0);
  });

  it("模型库目录不存在时拒绝启动", () => {
    const { env } = installEnv();
    const home = installedHome(env);
    rmSync(path.join(home, "models"), { recursive: true });
    const r = run(home, "cmd_start", env);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(path.join(home, "models"));
  });

  it("启用了 GPU 但运行时缺失时拒绝启动", () => {
    const { env } = installEnv();
    const r = run(installedHome(env, { gpu: 1 }), "cmd_start", env);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("nvidia-container-toolkit");
  });

  it("就绪超时返回 1 并提示看日志", () => {
    const { env } = installEnv({ STUB_HTTP_CODE: "502" });
    const r = run(installedHome(env), "cmd_start", env);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("llamapad logs");
  });

  it("restart 强制重建容器（让 .env 变更生效）", () => {
    const { env, log } = installEnv({ STUB_RUNNING: "true" });
    expect(run(installedHome(env), "cmd_restart", env).code).toBe(0);
    expect(readFileSync(log, "utf8")).toContain("docker compose up -d --force-recreate");
  });
});

describe("stop / status / logs", () => {
  it("stop 后发现模型容器仍在运行则询问，确认才一并停止", () => {
    const { env, log } = installEnv({ STUB_PS_MODELS: "llamapad-model\\n" });
    const home = installedHome(env);
    expect(run(home, "cmd_stop", env, "n\n").code).toBe(0);
    expect(readFileSync(log, "utf8")).toContain("docker compose stop");
    expect(readFileSync(log, "utf8")).not.toContain("docker stop llamapad-model");
    run(home, "cmd_stop", env, "y\n");
    expect(readFileSync(log, "utf8")).toContain("docker stop llamapad-model");
  });

  it("status 输出面板状态、镜像版本、监听地址与运行中的模型", () => {
    const { env } = installEnv({ STUB_PS: "Up 3 days\\n", STUB_PS_MODELS: "qwen3-27b\\n" });
    const r = run(installedHome(env), "cmd_status", env);
    expect(r.code).toBe(0);
    for (const s of ["Up 3 days", "0.1.0", "0.0.0.0:28960", "qwen3-27b"]) expect(r.stderr).toContain(s);
  });

  it("logs 默认 tail 200，-f 时跟随", () => {
    const { env, log } = installEnv();
    const home = installedHome(env);
    run(home, "cmd_logs", env);
    run(home, "OPT_FOLLOW=1; cmd_logs", env);
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain("docker compose logs --tail 200\n");
    expect(calls).toContain("docker compose logs --tail 200 -f\n");
  });
});

describe("主菜单", () => {
  it("已安装时无参数进入菜单：选「查看状态」后回到菜单，选「退出」结束", () => {
    const { env } = installEnv({ STUB_PS: "Up 1 hour\\n" });
    const home = installedHome(env);
    const r = runScript([], { env: { ...env, LLAMAPAD_HOME: home }, input: "3\n\n9\n" });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("llamapad");
    expect(r.stderr).toContain("Up 1 hour");
  });
});
