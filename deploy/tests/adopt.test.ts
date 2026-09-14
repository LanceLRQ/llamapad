import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { DEPLOY_DIR, installEnv, runScript, sh, tempDir } from "./sh";

// 每条用例都会 fork bash 并 source 整个脚本，全量并行跑多个测试文件时进程调度可能让
// 单条用例超过 vitest 默认的 5s，故本文件整体调宽超时（不改 vitest.config.ts）
vi.setConfig({ testTimeout: 30_000 });

const lines = (...xs: string[]) => xs.map((x) => `${x}\n`).join("");
const uid = process.getuid?.() ?? 1000;
const gid = process.getgid?.() ?? 1000;

/** 发布前手工部署的 compose 形态（本地构建镜像、group_add 写死、gpus 写在基础文件里） */
const OLD_COMPOSE = `services:
  llamapad:
    image: llamapad:v0.1.0-rc # 本地构建
    container_name: llamapad
    user: "\${PUID:-1000}:\${PGID:-1000}"
    ports:
      - "\${PANEL_PORT:-28960}:28960"
    gpus: all
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./data:/app/config
      - ./models:/host-models
      - /proc:/host/proc:ro
    group_add:
      - "984"
`;

function oldDeploy(envText: string, compose = OLD_COMPOSE): string {
  const home = tempDir("lp-old-");
  writeFileSync(path.join(home, "docker-compose.yml"), compose);
  writeFileSync(path.join(home, ".env"), envText);
  mkdirSync(path.join(home, "data"));
  mkdirSync(path.join(home, "models"));
  writeFileSync(path.join(home, "data/panel.db"), "DB-CONTENT");
  return home;
}

describe("adopt_extract_compose", () => {
  it("识别模型库挂载、GPU 与镜像", () => {
    const home = oldDeploy("");
    expect(sh(`adopt_extract_compose "${home}/docker-compose.yml"`).stdout).toBe(
      "MODELS_DIR=./models\nGPU=1\nIMAGE=llamapad:v0.1.0-rc\n",
    );
  });

  it("绝对路径挂载与带引号写法", () => {
    const home = oldDeploy("", `services:\n  llamapad:\n    image: "lancelrq/llamapad:0.1.0"\n    volumes:\n      - "/mnt/data/models:/host-models"\n`);
    expect(sh(`adopt_extract_compose "${home}/docker-compose.yml"`).stdout).toBe(
      "MODELS_DIR=/mnt/data/models\nGPU=0\nIMAGE=lancelrq/llamapad:0.1.0\n",
    );
  });
});

describe("接管端到端", () => {
  it("迁移旧值、补 DOCKER_GID、备份旧文件，data/ 零变动，保留自定义变量与注释", () => {
    const { env } = installEnv();
    const home = oldDeploy(`# 旧注释\nPANEL_ADMIN_PASSWORD=old-pass-123\nPUID=${uid}\nPGID=${gid}\nFOO=bar\n`);
    const r = runScript([], {
      env,
      input: lines(
        home, // 安装目录 = 旧部署目录 → 接管
        "", // 旧镜像不是 lancelrq/llamapad → 询问目标版本，回车取 0.1.0
        "", // 确认接管（默认是）
        "n", // 现在启动：否
      ),
    });
    expect(r.code).toBe(0);

    const backups = readdirSync(path.join(home, "backups")).filter((d) => d.startsWith("adopt-"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(path.join(home, "backups", backups[0]!, "docker-compose.yml"), "utf8")).toBe(OLD_COMPOSE);

    expect(readFileSync(path.join(home, "docker-compose.yml"), "utf8")).toBe(
      readFileSync(path.join(DEPLOY_DIR, "docker-compose.yml"), "utf8"),
    );
    const e = readFileSync(path.join(home, ".env"), "utf8");
    for (const line of [
      "# 旧注释",
      "FOO=bar",
      "PANEL_ADMIN_PASSWORD=old-pass-123",
      "LLAMAPAD_VERSION=0.1.0",
      "COMPOSE_FILE=docker-compose.yml:docker-compose.gpu.yml",
      "MODELS_DIR=./models",
      `DOCKER_GID=${statSync(env.LLAMAPAD_DOCKER_SOCK).gid}`,
    ]) {
      expect(e.split("\n")).toContain(line);
    }
    expect(readFileSync(path.join(home, "data/panel.db"), "utf8")).toBe("DB-CONTENT");
    expect(readFileSync(path.join(home, ".llamapad-state"), "utf8")).toContain("adopted_from=");
  });

  it("旧 .env 没有管理员密码（曾走首启 setup 页）时要求设置，留空随机", () => {
    const { env } = installEnv();
    const home = oldDeploy(`PUID=${uid}\nPGID=${gid}\n`);
    const r = runScript([], { env, input: lines(home, "", "", "", "n") });
    expect(r.code).toBe(0);
    expect(readFileSync(path.join(home, ".env"), "utf8")).toMatch(/^PANEL_ADMIN_PASSWORD=[A-Za-z0-9]{20}$/m);
  });

  it("已是新版 compose（按文档手工部署、无 state）：版本取自 .env，不再询问", () => {
    const { env } = installEnv();
    const home = oldDeploy(
      `LLAMAPAD_VERSION=0.1.0\nCOMPOSE_FILE=docker-compose.yml\nPANEL_ADMIN_PASSWORD=manual-pass-1\nPUID=${uid}\nPGID=${gid}\nMODELS_DIR=./models\n`,
      readFileSync(path.join(DEPLOY_DIR, "docker-compose.yml"), "utf8"),
    );
    const r = runScript([], { env, input: lines(home, "", "n") });
    expect(r.code).toBe(0);
    const e = readFileSync(path.join(home, ".env"), "utf8");
    expect(e).toContain("COMPOSE_FILE=docker-compose.yml\n");
    expect(e).toContain("MODELS_DIR=./models\n");
  });

  it("拒绝接管时不改动任何文件", () => {
    const { env } = installEnv();
    const home = oldDeploy(`PANEL_ADMIN_PASSWORD=old-pass-123\nPUID=${uid}\nPGID=${gid}\n`);
    const r = runScript([], { env, input: lines(home, "", "n") });
    expect(r.code).toBe(1);
    expect(readFileSync(path.join(home, "docker-compose.yml"), "utf8")).toBe(OLD_COMPOSE);
  });

  it("备份失败（backups 位置被同名文件占住，mkdir 出错）：原文件不变、报错、不落地新配置", () => {
    const { env } = installEnv();
    const home = oldDeploy(`PANEL_ADMIN_PASSWORD=old-pass-123\nPUID=${uid}\nPGID=${gid}\n`);
    // 用同名普通文件挡住 backups 目录，使 adopt_run 内的 mkdir -p 必然失败——
    // 与权限无关，root 下也一样会失败，比 chmod 只读更可靠
    writeFileSync(path.join(home, "backups"), "not-a-dir");
    const r = sh(`LP_HOME="${home}"; adopt_run`, { env, input: lines("", "y") });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("Failed to back up");
    expect(readFileSync(path.join(home, "docker-compose.yml"), "utf8")).toBe(OLD_COMPOSE);
    expect(existsSync(path.join(home, ".llamapad-state"))).toBe(false);
  });

  it("备份循环里 cp 失败（而非文件不存在）：中止，已备份的文件不影响判定，原文件不变", () => {
    const { env } = installEnv();
    // docker-compose.gpu.yml 在旧部署里本就不存在（[ -f ] 为假应跳过），
    // .env 存在但注入的 cp 失败（模拟磁盘只读等），docker-compose.yml 的 cp 正常成功——
    // 用这三种情形在同一条循环里验证「不存在就跳过」与「cp 失败即中止」不会混淆
    const home = oldDeploy(`PANEL_ADMIN_PASSWORD=old-pass-123\nPUID=${uid}\nPGID=${gid}\n`);
    const r = sh(
      `LP_HOME="${home}"
cp() { case "\$2" in *.env) return 1 ;; *) command cp "\$@" ;; esac; }
adopt_run`,
      { env, input: lines("", "y") },
    );
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("Failed to back up");
    expect(readFileSync(path.join(home, "docker-compose.yml"), "utf8")).toBe(OLD_COMPOSE);
    expect(existsSync(path.join(home, ".llamapad-state"))).toBe(false);
  });
});
