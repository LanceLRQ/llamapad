import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { DEPLOY_DIR, SCRIPT_VERSION, sh, tempDir } from "./sh";

const uid = String(process.getuid?.() ?? 1000);
const gid = String(process.getgid?.() ?? 1000);

/** 预置一组向导答案（运行身份取当前用户，避免测试里触发 chown 提权） */
function answers(home: string, extra = ""): string {
  return `LP_HOME="${home}"
wizard_defaults
W_DOCKER_GID=984 W_PUID=${uid} W_PGID=${gid} W_GPU=1 W_PORT=28960 W_BIND=0.0.0.0
W_MODELS_DIR=./models W_MODELS_NEW=1 W_PASSWORD='p@ss word$1' W_TZ=Asia/Shanghai
${extra}`;
}

describe("模板", () => {
  it("内嵌的 compose 模板与 deploy/ 下的文件逐字节一致", () => {
    expect(sh("tpl_compose").stdout).toBe(readFileSync(path.join(DEPLOY_DIR, "docker-compose.yml"), "utf8"));
    expect(sh("tpl_compose_gpu").stdout).toBe(readFileSync(path.join(DEPLOY_DIR, "docker-compose.gpu.yml"), "utf8"));
  });

  it("compose_file_value 按 GPU 开关给出 COMPOSE_FILE", () => {
    expect(sh("compose_file_value 1").stdout).toBe("docker-compose.yml:docker-compose.gpu.yml");
    expect(sh("compose_file_value 0").stdout).toBe("docker-compose.yml");
  });

  it("models_abs：相对路径相对部署目录，绝对路径原样", () => {
    expect(sh('LP_HOME=/opt/llamapad; models_abs ./models').stdout).toBe("/opt/llamapad/models");
    expect(sh('LP_HOME=/opt/llamapad; models_abs /mnt/data/m').stdout).toBe("/mnt/data/m");
  });

  it("wizard_defaults 给出默认值", () => {
    const r = sh('wizard_defaults; printf "%s|%s|%s|%s|%s" "$W_VERSION" "$W_PORT" "$W_BIND" "$W_PUID:$W_PGID" "$W_GPU"');
    expect(r.stdout).toBe(`${SCRIPT_VERSION}|28960|0.0.0.0|1000:1000|0`);
  });
});

describe("apply_install", () => {
  it("写出 compose、GPU 层、.env（600）、state 与 data/、models/", () => {
    const home = tempDir();
    const r = sh(`${answers(home)}\napply_install`);
    expect(r.code).toBe(0);

    expect(readFileSync(path.join(home, "docker-compose.yml"), "utf8")).toBe(
      readFileSync(path.join(DEPLOY_DIR, "docker-compose.yml"), "utf8"),
    );
    expect(existsSync(path.join(home, "docker-compose.gpu.yml"))).toBe(true);
    expect(existsSync(path.join(home, "data"))).toBe(true);
    expect(existsSync(path.join(home, "models"))).toBe(true);
    expect(existsSync(path.join(home, "backups"))).toBe(true);
    expect(statSync(path.join(home, "backups")).mode & 0o777).toBe(0o700);

    const env = readFileSync(path.join(home, ".env"), "utf8");
    expect(statSync(path.join(home, ".env")).mode & 0o777).toBe(0o600);
    expect(env).toMatch(/^# /);
    for (const line of [
      `LLAMAPAD_VERSION=${SCRIPT_VERSION}`,
      "COMPOSE_FILE=docker-compose.yml:docker-compose.gpu.yml",
      "PANEL_ADMIN_PASSWORD='p@ss word$1'",
      "DOCKER_GID=984",
      `PUID=${uid}`,
      `PGID=${gid}`,
      "PANEL_BIND=0.0.0.0",
      "PANEL_PORT=28960",
      "MODELS_DIR=./models",
      "TZ=Asia/Shanghai",
      "PANEL_LLM_BASE_URL=",
    ]) {
      expect(env.split("\n")).toContain(line);
    }

    const state = readFileSync(path.join(home, ".llamapad-state"), "utf8");
    expect(state).toContain("template_version=1");
    expect(state).toMatch(/compose_sha256=[0-9a-f]{64}/);
    expect(state).toMatch(/gpu_compose_sha256=[0-9a-f]{64}/);
    expect(state).toMatch(/installed_at=\d{4}-\d{2}-\d{2}T/);
  });

  it("GPU 关闭时 COMPOSE_FILE 只有基础文件", () => {
    const home = tempDir();
    sh(`${answers(home, "W_GPU=0")}\napply_install`);
    expect(readFileSync(path.join(home, ".env"), "utf8")).toContain("COMPOSE_FILE=docker-compose.yml\n");
  });

  it("已有 .env 时只按键替换，保留用户注释与自定义变量", () => {
    const home = tempDir();
    writeFileSync(path.join(home, ".env"), "# 我的备注\nMY_VAR=keep\nPANEL_PORT=1\n");
    sh(`${answers(home)}\napply_install`);
    const env = readFileSync(path.join(home, ".env"), "utf8");
    expect(env).toContain("# 我的备注\nMY_VAR=keep\nPANEL_PORT=28960\n");
  });

  it("模型库指向已存在的绝对路径时不创建也不改属主", () => {
    const home = tempDir();
    const models = path.join(tempDir(), "lib");
    mkdirSync(models);
    const r = sh(`${answers(home, `W_MODELS_DIR="${models}" W_MODELS_NEW=0`)}\napply_install`);
    expect(r.code).toBe(0);
    expect(readFileSync(path.join(home, ".env"), "utf8")).toContain(`MODELS_DIR=${models}\n`);
  });

  it("模型库目录建不起来时整体失败，不留下 state（否则重跑会被误判为已安装）", () => {
    const home = tempDir();
    const blocker = path.join(tempDir(), "blocker");
    writeFileSync(blocker, "");
    const models = path.join(blocker, "models");
    const r = sh(`${answers(home, `W_MODELS_DIR="${models}" W_MODELS_NEW=1`)}\napply_install`);
    expect(r.code).not.toBe(0);
    expect(existsSync(path.join(home, ".llamapad-state"))).toBe(false);
    expect(existsSync(path.join(home, ".env"))).toBe(false);
  });
});
