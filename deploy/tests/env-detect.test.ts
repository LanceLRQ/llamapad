import { chmodSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { STUBS_DIR, pathWith, sh, stubBin, tempDir } from "./sh";

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

function dockerEnv(extra: Record<string, string> = {}) {
  const bin = stubBin("docker", "sudo");
  const log = path.join(tempDir(), "calls.log");
  writeFileSync(log, "");
  return {
    log,
    env: {
      PATH: pathWith(bin),
      STUB_LOG: log,
      LLAMAPAD_SUDO: path.join(bin, "sudo"),
      LLAMAPAD_DOCKER_SOCK: path.join(tempDir(), "docker.sock"),
      ...extra,
    },
  };
}

describe("docker_probe", () => {
  it("docker 可用、有 compose v2：DK_STATE=ok，不走 sudo", () => {
    const { env } = dockerEnv();
    expect(sh('docker_probe; printf "%s %s" "$DK_STATE" "$DK_SUDO"', { env }).stdout).toBe("ok 0");
  });

  it("docker 命令不存在：missing，提示里给出官方安装文档", () => {
    const { env } = dockerEnv({ LLAMAPAD_DOCKER_BIN: "/nonexistent/docker" });
    const r = sh('docker_probe; printf "%s|" "$DK_STATE"; docker_probe_message', { env });
    expect(r.stdout).toMatch(/^missing\|/);
    expect(r.stdout).toContain("https://docs.docker.com/engine/install/");
  });

  it("daemon 连不上且 sock 不存在：daemon_down", () => {
    const { env } = dockerEnv({ STUB_INFO_EXIT: "1" });
    expect(sh('docker_probe; printf %s "$DK_STATE"', { env }).stdout).toBe("daemon_down");
  });

  it("rootless Docker：rootless", () => {
    const { env } = dockerEnv({ STUB_SECURITY: "[name=seccomp name=rootless]" });
    expect(sh('docker_probe; printf %s "$DK_STATE"', { env }).stdout).toBe("rootless");
  });

  it("缺 compose v2 插件：no_compose", () => {
    const { env } = dockerEnv({ STUB_COMPOSE_VERSION_EXIT: "1" });
    expect(sh('docker_probe; printf %s "$DK_STATE"', { env }).stdout).toBe("no_compose");
  });

  it.skipIf(isRoot)("非 root 且 sock 不可读写：改走 sudo，后续 dk 调用都带 sudo", async () => {
    const { env, log } = dockerEnv({ STUB_INFO_NEEDS_SUDO: "1" });
    const sock = env.LLAMAPAD_DOCKER_SOCK;
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(sock, resolve));
    try {
      chmodSync(sock, 0o000);
      const r = sh('docker_probe; printf "%s %s" "$DK_STATE" "$DK_SUDO"; dk ps >/dev/null', { env });
      expect(r.stdout).toBe("ok 1");
      expect(readFileSync(log, "utf8")).toContain("sudo docker ps");
    } finally {
      server.close();
    }
  });
});

describe("提权与平台", () => {
  it.skipIf(isRoot)("as_root 非 root 时经 sudo 执行；sudo 不可用时报错返回 1", () => {
    const { env, log } = dockerEnv();
    expect(sh("as_root true", { env }).code).toBe(0);
    expect(readFileSync(log, "utf8")).toContain("sudo true");
    const r = sh("as_root true", { env: { ...env, LLAMAPAD_SUDO: "/nonexistent/sudo" } });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("root");
  });

  it("platform_ok 可被 LLAMAPAD_SKIP_PLATFORM_CHECK 绕过", () => {
    expect(sh("platform_ok").code).toBe(0);
  });
});

describe("探测项", () => {
  it("detect_docker_gid 读 sock 的属组", () => {
    const sock = path.join(tempDir(), "docker.sock");
    writeFileSync(sock, "");
    expect(sh("detect_docker_gid", { env: { LLAMAPAD_DOCKER_SOCK: sock } }).stdout.trim()).toBe(
      String(statSync(sock).gid),
    );
  });

  it("gpu_cards 去掉 UUID；nvidia-smi 不存在时为空并返回 1", () => {
    const env = {
      LLAMAPAD_NVIDIA_SMI: path.join(STUBS_DIR, "nvidia-smi"),
      STUB_GPUS: "GPU 0: NVIDIA GeForce RTX 3090 (UUID: GPU-abc)\\nGPU 1: Tesla V100-PCIE-32GB (UUID: GPU-def)\\n",
    };
    expect(sh("gpu_cards", { env }).stdout).toBe("GPU 0: NVIDIA GeForce RTX 3090\nGPU 1: Tesla V100-PCIE-32GB\n");
    const none = sh("gpu_cards", { env: { LLAMAPAD_NVIDIA_SMI: "/nonexistent/nvidia-smi" } });
    expect(none).toMatchObject({ code: 1, stdout: "" });
  });

  it("gpu_runtime_ok：docker Runtimes 含 nvidia 或存在 CDI 规格文件", () => {
    const etc = tempDir();
    expect(sh("gpu_runtime_ok", dockerEnvWith({ STUB_RUNTIMES: '{"nvidia":{},"runc":{}}', LLAMAPAD_ETC: etc })).code).toBe(0);
    expect(sh("gpu_runtime_ok", dockerEnvWith({ LLAMAPAD_ETC: etc })).code).toBe(1);
    mkdirSync(path.join(etc, "cdi"));
    writeFileSync(path.join(etc, "cdi/nvidia.yaml"), "");
    expect(sh("gpu_runtime_ok", dockerEnvWith({ LLAMAPAD_ETC: etc })).code).toBe(0);
    const run = tempDir();
    mkdirSync(path.join(run, "cdi"));
    writeFileSync(path.join(run, "cdi/nvidia.yaml"), "");
    expect(sh("gpu_runtime_ok", dockerEnvWith({ LLAMAPAD_ETC: tempDir(), LLAMAPAD_RUN_DIR: run })).code).toBe(0);
  });

  it("detect_timezone：/etc/timezone → timedatectl → localtime 链接 → UTC", () => {
    const bin = stubBin("timedatectl");
    const a = tempDir();
    writeFileSync(path.join(a, "timezone"), "Asia/Shanghai\n");
    expect(sh("detect_timezone", { env: { LLAMAPAD_ETC: a, PATH: pathWith(bin) } }).stdout).toBe("Asia/Shanghai");
    const b = tempDir();
    symlinkSync("/usr/share/zoneinfo/Asia/Tokyo", path.join(b, "localtime"));
    expect(sh("detect_timezone", { env: { LLAMAPAD_ETC: b, PATH: pathWith(bin) } }).stdout).toBe("Asia/Tokyo");
    expect(sh("detect_timezone", { env: { LLAMAPAD_ETC: tempDir(), PATH: pathWith(bin) } }).stdout).toBe("UTC");
  });

  it("access_urls：0.0.0.0 列出局域网 IPv4 与本机；指定地址只给该地址", () => {
    const env = { PATH: pathWith(stubBin("hostname")), STUB_IPS: "192.168.1.20 10.0.0.5 fe80::1" };
    expect(sh("access_urls 0.0.0.0 28960", { env }).stdout).toBe(
      "http://192.168.1.20:28960\nhttp://10.0.0.5:28960\nhttp://127.0.0.1:28960\n",
    );
    expect(sh("access_urls 127.0.0.1 30000", { env }).stdout).toBe("http://127.0.0.1:30000\n");
  });
});

function dockerEnvWith(extra: Record<string, string>) {
  return { env: dockerEnv(extra).env };
}
