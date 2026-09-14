import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { SCRIPT, installEnv, runScript, sh, tempDir } from "./sh";

// 每条用例都会 fork bash 并 source 整个脚本，全量并行跑多个测试文件时进程调度可能让
// 单条用例超过 vitest 默认的 5s，故本文件整体调宽超时（不改 vitest.config.ts）
vi.setConfig({ testTimeout: 30_000 });

/** 按行拼数字菜单模式下的输入 */
const lines = (...xs: string[]) => xs.map((x) => `${x}\n`).join("");

describe("choose_* 单步", () => {
  it("choose_port 拒绝非法与被占用端口，直到给出可用值", () => {
    const { env } = installEnv({ STUB_SS: "State Recv-Q Send-Q Local Address:Port Peer\\nLISTEN 0 1 0.0.0.0:28960 0.0.0.0:*\\n" });
    const r = sh('wizard_defaults; choose_port; printf %s "$W_PORT"', { env, input: lines("", "abc", "70000", "30001") });
    expect(r.stdout).toBe("30001");
    expect(r.stderr).toContain("28960");
  });

  it("choose_bind 自定义地址需是 IPv4", () => {
    const r = sh('wizard_defaults; choose_bind; printf %s "$W_BIND"', { input: lines("3", "not-ip", "10.0.0.8") });
    expect(r.stdout).toBe("10.0.0.8");
  });

  it("choose_password：留空随机 20 位；太短、含单引号、两次不一致都会重问", () => {
    const random = sh('wizard_defaults; choose_password; printf "%s|%s" "$W_PASSWORD" "$W_PASSWORD_GENERATED"', { input: lines("") });
    expect(random.stdout).toMatch(/^[A-Za-z0-9]{20}\|1$/);
    const typed = sh('wizard_defaults; choose_password; printf "%s|%s" "$W_PASSWORD" "$W_PASSWORD_GENERATED"', {
      input: lines("short", "it's-long-enough", "good-pass-1", "other-pass-1", "good-pass-1", "good-pass-1"),
    });
    expect(typed.stdout).toBe("good-pass-1|0");
  });

  it("choose_models_dir 手动输入需是绝对路径且不含空格冒号；已存在的目录报告模型文件数", () => {
    const { env } = installEnv();
    const lib = path.join(tempDir(), "lib");
    mkdirSync(lib);
    writeFileSync(path.join(lib, "a.gguf"), "x");
    const r = sh(`LP_HOME="${tempDir()}"; wizard_defaults; choose_models_dir; printf "%s|%s" "$W_MODELS_DIR" "$W_MODELS_NEW"`, {
      env,
      input: lines("2", "relative/path", "/has space", lib),
    });
    expect(r.stdout).toBe(`${lib}|0`);
    expect(r.stderr).toContain("1 GGUF");
  });
});

describe("全新安装端到端（数字菜单模式）", () => {
  it("一路默认：写出部署文件、命令入口，随机密码只显示一次", () => {
    const { env, root, launcherDir } = installEnv();
    const target = path.join(root, "opt-llamapad");
    const r = runScript([], {
      env,
      input: lines(
        target, // 安装目录
        "1", // 镜像来源：Docker Hub（默认选中）
        "1", // 模型库：默认位置
        "2", // 运行身份：当前用户（避免测试里 chown 提权）
        "", // 端口 28960
        "1", // 监听 0.0.0.0
        "", // 密码留空 → 随机
        "", // 时区默认
        "", // 外部 LLM：否
        "1", // 汇总：确认
        "n", // 现在启动：否
      ),
    });
    expect(r.code).toBe(0);
    expect(readFileSync(path.join(target, "llamapad.sh"), "utf8")).toBe(readFileSync(SCRIPT, "utf8"));
    expect(existsSync(path.join(target, "docker-compose.yml"))).toBe(true);
    expect(existsSync(path.join(target, "models"))).toBe(true);
    const envText = readFileSync(path.join(target, ".env"), "utf8");
    const pw = /^PANEL_ADMIN_PASSWORD=([A-Za-z0-9]{20})$/m.exec(envText)?.[1];
    expect(pw).toBeDefined();
    expect(envText).toContain("LLAMAPAD_IMAGE=lancelrq/llamapad\n");
    expect(envText).toContain("COMPOSE_FILE=docker-compose.yml\n");
    expect(envText).toContain("TZ=Asia/Shanghai\n");
    expect(envText).toContain(`MODELS_DIR=${target}/models\n`);
    expect(r.stderr).toContain(pw!);
    expect(r.stderr).toContain("http://192.168.1.20:28960");
    expect(readFileSync(path.join(launcherDir, "llamapad"), "utf8")).toContain(`${target}/llamapad.sh`);
    expect(readFileSync(path.join(target, ".llamapad-state"), "utf8")).toContain("image_source=hub\n");
  });

  it("汇总页可跳回修改某项；选择取消则不写任何部署文件", () => {
    const { env, root } = installEnv();
    const target = path.join(root, "t2");
    // 汇总页第 6 项（1 起）是端口：确认(0) 镜像(1) 模型库(2) 身份(3) GPU(4) 端口(5) …
    runScript([], {
      env,
      input: lines(target, "1", "1", "2", "", "1", "", "", "", "6", "30005", "1", "n"),
    });
    expect(readFileSync(path.join(target, ".env"), "utf8")).toContain("PANEL_PORT=30005\n");

    const cancelTarget = path.join(root, "t3");
    // 取消项挪到末尾（新增了「镜像」这一行），1 起第 11 项
    const r = runScript([], { env, input: lines(cancelTarget, "1", "1", "2", "", "1", "", "", "", "11") });
    expect(r.code).toBe(1);
    expect(existsSync(path.join(cancelTarget, ".env"))).toBe(false);
    expect(existsSync(path.join(cancelTarget, ".llamapad-state"))).toBe(false);
  });

  it("安装目录校验：系统目录被拒绝需重新输入；非空无关目录默认拒绝，可重新指定目录", () => {
    const { env, root } = installEnv();
    const nonEmpty = path.join(root, "already-has-stuff");
    mkdirSync(nonEmpty, { recursive: true });
    writeFileSync(path.join(nonEmpty, "unrelated.txt"), "x");
    const target = path.join(root, "final");
    const r = runScript([], {
      env,
      input: lines(
        "/usr", // 系统目录，应被拒绝并重新询问
        nonEmpty, // 非空且与 llamapad 无关的目录，默认拒绝
        "n", // 拒绝使用该非空目录
        target, // 重新给一个全新目录
        "1", "1", "2", "", "1", "", "", "", "1", "n",
      ),
    });
    expect(r.code).toBe(0);
    expect(existsSync(path.join(target, ".env"))).toBe(true);
    expect(r.stderr).toContain("cannot be used as the install directory");
    expect(r.stderr).toContain("already exists and is not empty");
  });

  it("选择现在启动但 docker compose up 失败：不显示安装完成页，改为提示排查，退出码非零", () => {
    const { env, root } = installEnv({ STUB_COMPOSE_EXIT: "1" });
    const target = path.join(root, "start-fail");
    const r = runScript([], {
      env,
      input: lines(target, "1", "1", "2", "", "1", "", "", "", "1", "y"),
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("registry-mirrors");
    expect(r.stderr).not.toContain("Installation complete");
    expect(existsSync(path.join(target, ".env"))).toBe(true);
  });

  it("install_launcher 失败时不中断安装，只降级提示直接运行脚本本体", () => {
    const { env, root } = installEnv();
    const target = path.join(root, "launcher-fail");
    const r = sh(
      `install_launcher() { return 1; }
cmd_install`,
      { env, input: lines(target, "1", "1", "2", "", "1", "", "", "", "1", "n") },
    );
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("was not installed");
    expect(existsSync(path.join(target, ".env"))).toBe(true);
  });

  it("检测到 GPU 且有运行时：默认启用并写入 GPU 叠加层", () => {
    const { env, root } = installEnv({
      LLAMAPAD_NVIDIA_SMI: path.join(__dirname, "fixtures/stubs/nvidia-smi"),
      STUB_GPUS: "GPU 0: NVIDIA GeForce RTX 3090 (UUID: GPU-1)\\n",
      STUB_RUNTIMES: '{"nvidia":{}}',
    });
    const target = path.join(root, "gpu");
    const r = runScript([], { env, input: lines(target, "1", "1", "2", "", "", "1", "", "", "", "1", "n") });
    expect(r.stderr).toContain("RTX 3090");
    expect(readFileSync(path.join(target, ".env"), "utf8")).toContain(
      "COMPOSE_FILE=docker-compose.yml:docker-compose.gpu.yml\n",
    );
  });
});
