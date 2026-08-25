import { randomBytes } from "node:crypto";
import type { ContainerSpec, DockerAdapter } from "./types";

/**
 * 内存 Mock 适配器（M0 Task 6；M0 全程不依赖真实 Docker）
 *
 * 语义对齐 docker CLI（bash 前身同款用法）：
 * - start ≈ docker run -d：同名容器先移除旧实例（recreate）；id 形如
 *   "mock-" + 12 位随机 hex（贴近 docker 的 64 位 hex id 的短形态）
 * - stop ≈ docker rm（bash 前身用 docker run -d --rm，容器一旦停止即消失）：
 *   stop 后 status 返回 null 而非 "exited"——容器已被移除，不再是任何状态；
 *   幂等，对不存在的容器不抛错（等价 docker rm 的 || true 容错用法）
 * - logs ≈ docker logs [--tail N]：返回伪造的 llama.cpp 风格日志行；
 *   容器已 rm 则日志随之消失，返回空串
 */

/** mock 内部记录的容器 */
interface MockContainer {
  id: string;
  spec: ContainerSpec;
  startedAt: string;
  logs: string[];
  /** followLogs 的自定义行序列（setLogScript 注入）；播完后静默 */
  script: string[] | null;
}

/**
 * Mock 专属内省接口：暴露内部记录的 spec，供测试/调试查询 labels 等信息。
 * 仅 mock 提供，DockerAdapter 接口不包含它（真实 dockerode 也查不到 spec）。
 */
export interface MockDockerAdapter extends DockerAdapter {
  specOf(name: string): ContainerSpec | null;
  /**
   * 注入 followLogs 要推送的自定义行序列（测试辅助）：按序每 tick 推一行，
   * 播完后静默（不回落到伪造行，保证断言确定性）。清空传 []。
   */
  setLogScript(name: string, lines: string[]): void;
}

/** 伪造 llama.cpp 风格日志：每行 "ISO 时间戳 llama-server: 消息" */
function fakeLogLines(spec: ContainerSpec): string[] {
  const messages = [
    `build: llama.cpp mock build for ${spec.image}`,
    `system info: threads | AVX | CUDA (mock device for ${spec.gpu})`,
    `loading model for container '${spec.name}'`,
    "llama_model_loader: loaded meta data (mock)",
    "llama_model_load_from_file_impl: using device CUDA0 (mock)",
    `kv self size: cache-type-k/v applied (mock)`,
    `listen: listening on 0.0.0.0:${spec.containerPort}`,
    "main: server is ready to handle requests",
  ];
  const t0 = Date.now() - messages.length * 100;
  return messages.map((message, i) => `${new Date(t0 + i * 100).toISOString()} llama-server: ${message}`);
}

/** 生成容器 id："mock-" + 12 位随机 hex */
function mockId(): string {
  return `mock-${randomBytes(6).toString("hex")}`;
}

export function createMockDockerAdapter(): MockDockerAdapter {
  const containers = new Map<string, MockContainer>();

  function get(name: string): MockContainer | undefined {
    return containers.get(name);
  }

  return {
    async start(spec) {
      // recreate：同名容器先移除旧实例（docker run --name 冲突时的既有约定）
      containers.delete(spec.name);
      const container: MockContainer = {
        id: mockId(),
        spec,
        startedAt: new Date().toISOString(),
        logs: fakeLogLines(spec),
        script: null,
      };
      containers.set(spec.name, container);
      return { id: container.id };
    },

    async stop(name) {
      // docker rm 语义：直接删除记录；不存在时静默（幂等）
      containers.delete(name);
    },

    async status(name) {
      const container = get(name);
      if (!container) return null;
      // mock 容器只会 running（stop 即 rm，不存在 exited 中间态）
      return {
        name: container.spec.name,
        id: container.id,
        state: "running",
        startedAt: container.startedAt,
        labels: container.spec.labels,
      };
    },

    async isRunning(name) {
      return get(name) !== undefined;
    },

    async list(filter) {
      const label = filter?.label;
      let matched = [...containers.values()];
      if (label !== undefined && label !== "") {
        // docker --filter label=key=value 语义：精确匹配；无 "=" 时匹配"存在该 key"
        const eq = label.indexOf("=");
        matched = matched.filter((c) =>
          eq === -1 ? label in c.spec.labels : c.spec.labels[label.slice(0, eq)] === label.slice(eq + 1),
        );
      }
      // mock 容器只会 running；与 status 同形态返回（含 labels）
      return matched.map((c) => ({
        name: c.spec.name,
        id: c.id,
        state: "running" as const,
        startedAt: c.startedAt,
        labels: c.spec.labels,
      }));
    },

    async logs(name, tail) {
      const container = get(name);
      if (!container) return "";
      const lines =
        tail === undefined ? container.logs : container.logs.slice(Math.max(0, container.logs.length - tail));
      return lines.join("\n");
    },

    async followLogs(name, onLine) {
      // 容器不存在（未创建/已 rm）→ 静默空句柄：对齐 logs 的"日志随容器消失"语义
      if (!get(name)) {
        return { stop: async () => undefined };
      }
      let stopped = false;
      let n = 0;
      const timer = setInterval(() => {
        if (stopped) return;
        // 容器在 follow 期间被 stop（=rm）：日志随容器消失，自动收摊
        const container = get(name);
        if (!container) {
          clearInterval(timer);
          return;
        }
        if (container.script !== null) {
          // 自定义脚本：按序各推一次，播完静默（确定性）
          if (n < container.script.length) onLine(container.script[n++]!);
          return;
        }
        n += 1;
        onLine(`${new Date().toISOString()} llama-server: msg #${n}`);
      }, 200);
      return {
        stop: async () => {
          stopped = true;
          clearInterval(timer);
        },
      };
    },

    specOf(name) {
      return get(name)?.spec ?? null;
    },

    setLogScript(name, lines) {
      const container = get(name);
      if (container) container.script = lines;
    },
  };
}
