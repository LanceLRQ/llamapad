import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { STUBS_DIR, installEnv, installedHome, sh, tempDir } from "./sh";

// 每条用例都会 fork bash 并 source 整个脚本，全量并行跑多个测试文件时进程调度可能让
// 单条用例超过 vitest 默认的 5s，故本文件整体调宽超时（不改 vitest.config.ts）
vi.setConfig({ testTimeout: 30_000 });

const lines = (...xs: string[]) => xs.map((x) => `${x}\n`).join("");
const envOf = (home: string) => readFileSync(path.join(home, ".env"), "utf8");

function config(input: string, extra: Record<string, string> = {}) {
  const { env, log } = installEnv(extra);
  const home = installedHome(env);
  const r = sh(`LP_HOME="${home}"; docker_probe >/dev/null 2>&1; cmd_config`, { env, input });
  return { r, home, log };
}

describe("cmd_config", () => {
  it("改端口：写入 PANEL_PORT，选择稍后生效则不重启", () => {
    const { r, home, log } = config(lines("1", "30000", "9", "n"));
    expect(r.code).toBe(0);
    expect(envOf(home)).toContain("PANEL_PORT=30000\n");
    expect(readFileSync(log, "utf8")).not.toContain("up -d");
  });

  it("改监听地址为仅本机", () => {
    const { home } = config(lines("2", "2", "9", "n"));
    expect(envOf(home)).toContain("PANEL_BIND=127.0.0.1\n");
  });

  it("改模型库到新的绝对路径：创建目录并提示不会搬文件", () => {
    const target = path.join(tempDir(), "new-lib");
    const { r, home } = config(lines("3", "2", target, "9", "n"));
    expect(envOf(home)).toContain(`MODELS_DIR=${target}\n`);
    expect(r.stderr).toContain("not moved");
  });

  it("改运行身份为当前用户", () => {
    const { home } = config(lines("4", "2", "9", "n"));
    expect(envOf(home)).toContain(`PUID=${process.getuid?.() ?? 1000}\n`);
  });

  // root 下 chown 到 root 必然成功，「修改失败」分支无从触发
  it.skipIf(process.getuid?.() === 0)("身份分支 fix_owner 失败（chown 到 root 且无 sudo）时不写 .env，并提示修改失败", () => {
    const { r, home } = config(lines("4", "3", "9"));
    expect(r.code).toBe(0);
    expect(envOf(home)).toContain(`PUID=${process.getuid?.() ?? 1000}\n`);
    expect(envOf(home)).not.toContain("PUID=0\n");
    expect(r.stderr).toContain("identity was not changed");
  });

  it("开启 GPU：COMPOSE_FILE 叠加 GPU 层", () => {
    const { home } = config(lines("5", "", "9", "n"), {
      LLAMAPAD_NVIDIA_SMI: path.join(STUBS_DIR, "nvidia-smi"),
      STUB_GPUS: "GPU 0: Tesla V100 (UUID: GPU-1)\\n",
      STUB_RUNTIMES: '{"nvidia":{}}',
    });
    expect(envOf(home)).toContain("COMPOSE_FILE=docker-compose.yml:docker-compose.gpu.yml\n");
  });

  it("配置外部 LLM：直接进入三项输入，不再先问是否配置", () => {
    const { home } = config(lines("7", "https://api.example.com/v1", "sk-1", "gpt-x", "9", "n"));
    const e = envOf(home);
    expect(e).toContain("PANEL_LLM_BASE_URL=https://api.example.com/v1\n");
    expect(e).toContain("PANEL_LLM_API_KEY=sk-1\n");
    expect(e).toContain("PANEL_LLM_MODEL=gpt-x\n");
  });

  it("配置外部 LLM：某项输入含单引号被拒绝重问，改用合法值后正确写入", () => {
    const { r, home } = config(lines("7", "bad'url", "https://api.example.com/v1", "sk-1", "gpt-x", "9", "n"));
    const e = envOf(home);
    expect(e).toContain("PANEL_LLM_BASE_URL=https://api.example.com/v1\n");
    expect(e).toContain("PANEL_LLM_API_KEY=sk-1\n");
    expect(e).toContain("PANEL_LLM_MODEL=gpt-x\n");
    expect(r.stderr).toContain("single quotes");
  });

  it("管理员密码留空随机：写入 .env 并显示，提示重启后旧登录失效", () => {
    const { r, home } = config(lines("8", "", "9", "n"));
    const pw = /^PANEL_ADMIN_PASSWORD=([A-Za-z0-9]{20})$/m.exec(envOf(home))?.[1];
    expect(pw).toBeDefined();
    expect(pw).not.toBe("initial-pass-1");
    expect(r.stderr).toContain(pw!);
    expect(r.stderr).toContain("sign in again");
  });

  it("改时区后选择立即生效：强制重建容器", () => {
    const { home, log } = config(lines("6", "Europe/Berlin", "9", "y"), { STUB_RUNNING: "true" });
    expect(envOf(home)).toContain("TZ=Europe/Berlin\n");
    expect(readFileSync(log, "utf8")).toContain("docker compose up -d --force-recreate");
  });

  it("时区含单引号被拒绝重问", () => {
    const { r, home } = config(lines("6", "Europe'Berlin", "Europe/Berlin", "9", "n"));
    expect(envOf(home)).toContain("TZ=Europe/Berlin\n");
    expect(r.stderr).toContain("cannot be empty or contain spaces");
  });

  it("什么都没改直接返回：不询问是否生效", () => {
    const { r, log } = config(lines("9"));
    expect(r.code).toBe(0);
    expect(readFileSync(log, "utf8")).not.toContain("up -d");
  });
});

describe("config_load_env", () => {
  it("从 .env 读回 W_*，模型库目录不存在时视为新目录", () => {
    const { env } = installEnv();
    const home = installedHome(env, { gpu: 1 });
    mkdirSync(path.join(home, "models"), { recursive: true });
    const r = sh(`LP_HOME="${home}"; config_load_env; printf "%s|%s|%s|%s" "$W_PORT" "$W_GPU" "$W_MODELS_NEW" "$W_PASSWORD"`, { env });
    expect(r.stdout).toBe("28960|1|0|initial-pass-1");
  });
});
