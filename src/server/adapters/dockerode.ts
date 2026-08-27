import { PassThrough, Readable } from "node:stream";
import type dockerode from "dockerode";
import Docker from "dockerode";
import { LineSplitter } from "../../core/line-splitter";
import type { PullFrame } from "../../core/pull-progress";
import { buildCreateOptions } from "./docker-options";
import type { ContainerSpec, ContainerStatsSample, DockerAdapter } from "./types";

/**
 * dockerode 真实适配器（M1 Task 5）
 *
 * socket 默认 /var/run/docker.sock，可用环境变量 PANEL_DOCKER_SOCKET 覆盖
 * （显式参数 > 环境变量 > 默认）；dockerode 连接是惰性的——构造不发 IO，
 * 首次调用才触碰 daemon。
 *
 * GPU 三形态（"all"/"none"/"device=N"）经 buildCreateOptions 映射为
 * DeviceRequests（docker-options.test.ts 单测锚定）；Mac Docker Desktop
 * 不支持 --gpus，集成测试只用 gpu:"none"，GPU 真机验证留 M4。
 *
 * start 的关键点是"启动即退"检测：buildCreateOptions 设了 AutoRemove:true
 * （--rm 语义），容器一退出 daemon 即移除、日志随容器消失——logs API 对
 * dead/移除中的容器直接回 409/404，瞬时退出的容器根本来不及查日志。
 * 所以采用 `docker run` 同款做法：created 状态先 attach 挂流（hijack +
 * demuxStream 拆复用），再 start；之后轮询 inspect（每 2s 共 5 次）判死，
 * 无论抓到 exited 还是容器已被移除（404），错误消息里都带着 attach 流
 * 先收到的尾部日志。
 */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** dockerode 错误的 HTTP 状态码（modem 抛的错带 statusCode，如 404/409） */
function statusCodeOf(err: unknown): number | undefined {
  return typeof err === "object" && err !== null && "statusCode" in err
    ? (err as { statusCode?: number }).statusCode
    : undefined;
}

/** err 是否为指定 HTTP 状态码（如 404 镜像/容器不存在、409 冲突） */
function isStatus(err: unknown, code: number): boolean {
  return statusCodeOf(err) === code;
}

/** followLogs 的 logs API 选项：≈ docker logs -f --tail 100（attach 先补尾部再实时）。
 *  返回类型带字面量 follow:true——dockerode 重载据此把 Promise 解析为流而非 Buffer */
export function buildFollowLogOptions(): dockerode.ContainerLogsOptions & { follow: true } {
  return { follow: true, stdout: true, stderr: true, tail: 100 };
}

/** followLogs 的句柄：stop 幂等，重复调用直接返回 */
export interface FollowLogsHandle {
  stop(): Promise<void>;
}

/** 空转句柄：容器不存在（404）时的静默返回——stop 无操作（对齐 mock 语义） */
function idleFollowHandle(): FollowLogsHandle {
  return { stop: async () => undefined };
}

/** 取文本末尾 n 行（去掉行尾空行），作为错误消息里的日志摘要 */
function tailLines(text: string, n: number): string {
  const lines = text.replace(/\r/g, "").split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-n).join("\n");
}

/**
 * docker stats 单帧 JSON → ContainerStatsSample（纯函数，公式单测锚定）。
 * CPU% = (cpuΔ / systemΔ) × online_cpus × 100 —— docker stats CLI 同款公式：
 * cpuΔ = cpu_stats.cpu_usage.total_usage - precpu_stats.cpu_usage.total_usage，
 * systemΔ = cpu_stats.system_cpu_usage - precpu_stats.system_cpu_usage；
 * systemΔ ≤ 0（首帧无 precpu / 时钟异常）或 cpuΔ < 0（计数器回绕）→ 0，
 * 结果 clamp 到 0 ~ onlineCpus×100（物理上界，只防 systemΔ 抖动算出天文数字，
 * 不再硬编 400——16 核满载就该显示 1600，否则「打满」和「用了 4 核」在面板上
 * 是同一个数字）；online_cpus 缺省（0，旧 daemon）时回退 percpu_usage 数量。
 * 内存取 memory_stats.usage / limit（usage 缺失 → 0）；网络把 networks
 * 各接口的 rx_bytes / tx_bytes 求和（host network 无 networks → 0）。
 */
export function containerStatsToSample(
  frame: dockerode.ContainerStats,
  ts: number,
): ContainerStatsSample {
  const cpuDelta = frame.cpu_stats.cpu_usage.total_usage - frame.precpu_stats.cpu_usage.total_usage;
  const systemDelta = frame.cpu_stats.system_cpu_usage - frame.precpu_stats.system_cpu_usage;
  // 类型上 percpu_usage 必有，但 cgroup v2 下 daemon 可能不回填——按可缺省防御
  const percpu = frame.cpu_stats.cpu_usage.percpu_usage as number[] | undefined;
  const onlineCpus = frame.cpu_stats.online_cpus || percpu?.length || 1;

  let cpuPercent =
    systemDelta > 0 && cpuDelta > 0 ? (cpuDelta / systemDelta) * onlineCpus * 100 : 0;
  cpuPercent = Math.min(onlineCpus * 100, Math.max(0, cpuPercent));

  let netRxBytes = 0;
  let netTxBytes = 0;
  for (const iface of Object.values(frame.networks ?? {})) {
    netRxBytes += iface?.rx_bytes ?? 0;
    netTxBytes += iface?.tx_bytes ?? 0;
  }

  return {
    cpuPercent,
    cpuCount: onlineCpus,
    memBytes: frame.memory_stats?.usage ?? 0,
    memLimitBytes: frame.memory_stats?.limit ?? 0,
    netRxBytes,
    netTxBytes,
    ts,
  };
}

interface Demuxed {
  stdout: string;
  stderr: string;
}

/**
 * 用 modem.demuxStream 拆 docker 复用流（8 字节帧头：[流类型,0,0,0,长度BE32]），
 * stdout/stderr 各收进一个 PassThrough 后合并收集。
 * 永不 reject：流 end/close/error 或 settleMs 超时都视为收完（保留已收数据）。
 * 最后等一个 setImmediate，让 PassThrough 队列里最后的 data 事件派发完。
 */
function demuxToString(docker: Docker, stream: NodeJS.ReadableStream, settleMs: number): Promise<Demuxed> {
  const out = new PassThrough();
  const errOut = new PassThrough();
  let stdout = "";
  let stderr = "";
  out.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  errOut.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  docker.modem.demuxStream(stream, out, errOut);
  return new Promise<Demuxed>((resolve) => {
    const done = () => resolve({ stdout, stderr });
    stream.on("end", done);
    stream.on("close", done);
    stream.on("error", done);
    setTimeout(done, settleMs);
  }).then(async (result) => {
    await new Promise((resolve) => setImmediate(resolve));
    return result;
  });
}

/** start() 期间跟随收集的尾部日志：容器退出/移除后仍能给出已收到的输出 */
interface LogCapture {
  /** 等流结束（或超时）后返回合并文本（stdout + stderr） */
  text(): Promise<string>;
  /** 丢弃捕获（启动成功路径：销毁 follow 流，释放连接） */
  stop(): void;
}

/**
 * 真实 dockerode 适配器：DockerAdapter 之外暴露 kind（区分 mock/real 的
 * 运行时标记）与 socketPath（内省用），isDockerodeAdapter 做类型守卫。
 */
export interface DockerodeAdapter extends DockerAdapter {
  readonly kind: "dockerode";
  readonly socketPath: string;
}

/** 类型守卫：区分真实 dockerode 适配器与 mock（mock 无 kind 标记） */
export function isDockerodeAdapter(adapter: DockerAdapter): adapter is DockerodeAdapter {
  return (adapter as DockerodeAdapter).kind === "dockerode";
}

/** socket 解析：显式参数 > PANEL_DOCKER_SOCKET > /var/run/docker.sock */
function resolveSocketPath(explicit?: string): string {
  return explicit ?? process.env.PANEL_DOCKER_SOCKET ?? "/var/run/docker.sock";
}

export function createDockerodeAdapter(socketPath?: string): DockerodeAdapter {
  const resolved = resolveSocketPath(socketPath);
  const docker = new Docker({ socketPath: resolved });

  /** inspect 容器；404（不存在/已移除）返回 null，其余错误上抛 */
  async function inspectOrNull(name: string): Promise<dockerode.ContainerInspectInfo | null> {
    try {
      return await docker.getContainer(name).inspect();
    } catch (err) {
      if (isStatus(err, 404)) return null;
      throw err;
    }
  }

  /** 强制移除同名旧实例（docker rm -f = kill + rm，recreate 语义）；404 静默 */
  async function removeIfExists(name: string): Promise<void> {
    try {
      await docker.getContainer(name).remove({ force: true });
    } catch (err) {
      if (!isStatus(err, 404)) throw err;
    }
  }

  /**
   * docker pull + followProgress 等待分层拉取完成（任一层失败即 reject）。
   * onProgress 原样透传 followProgress 的逐帧回调（U14 起接口公开，供
   * SSE 进度条消费）；createWithAutoPull 内部调用不传 onProgress，行为不变。
   */
  async function pullImage(image: string, onProgress?: (frame: PullFrame) => void): Promise<void> {
    const stream = await docker.pull(image);
    await new Promise<void>((resolve, reject) => {
      docker.modem.followProgress(
        stream,
        (err) => (err ? reject(err) : resolve()),
        onProgress ? (event) => onProgress(event as PullFrame) : undefined,
      );
    });
  }

  /** 创建容器；404（镜像不存在）时先 pull 再重试一次 */
  async function createWithAutoPull(spec: ContainerSpec): Promise<dockerode.Container> {
    const options = buildCreateOptions(spec);
    try {
      return await docker.createContainer(options);
    } catch (err) {
      if (!isStatus(err, 404)) throw err;
      await pullImage(spec.image);
      return await docker.createContainer(options);
    }
  }

  /**
   * created 状态先 attach 挂流（docker run 语义：attach → start）。
   * 必须在 start 前挂：容器退出并被 AutoRemove 移除后 logs API 回
   * 409（dead/marked for removal）或 404，瞬时退出的容器日志只有
   * 提前挂好的 attach 流才收得到。不 await 收完，随轮询结果再取。
   */
  async function openAttachCapture(container: dockerode.Container): Promise<LogCapture> {
    const stream = await container.attach({ stream: true, stdout: true, stderr: true, hijack: true });
    const collected = demuxToString(docker, stream, 5_000);
    return {
      text: async () => {
        const { stdout, stderr } = await collected;
        return stdout + stderr;
      },
      stop: () => {
        // hijack attach 返回 net.Socket（类型上只有 ReadWriteStream），鸭子类型调用 destroy
        (stream as { destroy?: () => void }).destroy?.();
      },
    };
  }

  return {
    kind: "dockerode",
    socketPath: resolved,

    async start(spec) {
      // recreate 语义：同名旧实例先强制移除
      await removeIfExists(spec.name);
      const container = await createWithAutoPull(spec);
      const capture = await openAttachCapture(container);
      try {
        await container.start();

        // 启动即退检测：每 2s 轮询一次 inspect，共 5 次；全部在运行才算启动成功
        for (let poll = 0; poll < 5; poll++) {
          await sleep(2_000);
          let info: dockerode.ContainerInspectInfo;
          try {
            info = await container.inspect();
          } catch (err) {
            if (isStatus(err, 404)) {
              // AutoRemove 已把退出的容器移除：exit code 无从查询，摘要给出 attach 流收到的日志
              throw new Error(`容器启动即退出（容器已自动移除）: ${tailLines(await capture.text(), 30)}`);
            }
            throw err;
          }
          if (!info.State.Running || info.State.Status === "exited") {
            throw new Error(`容器启动即退出（exit ${info.State.ExitCode}）: ${tailLines(await capture.text(), 30)}`);
          }
        }
      } catch (err) {
        // 任何失败路径都销毁 attach 流（成功路径在下方 stop），避免连接泄漏
        capture.stop();
        throw err;
      }

      // 轮询全程在运行：启动成功，丢弃日志捕获（销毁 attach 流，释放连接）
      capture.stop();
      // 与 status().id 一致用 12 位短 id（docker CLI 惯例）；完整 64 位 id 调用方不需要
      return { id: container.id.slice(0, 12) };
    },

    async stop(name) {
      const container = docker.getContainer(name);
      try {
        await container.kill();
      } catch (err) {
        // 404：容器不存在（从未创建/已移除）→ 幂等返回
        if (isStatus(err, 404)) return;
        // 409：kill 的前置条件不满足——daemon 对 created/exited 容器回 409
        // ("container is not running")；确认其确已不在运行则视为已停止
        if (isStatus(err, 409)) {
          const info = await inspectOrNull(name);
          if (!info || !info.State.Running) return;
          throw err;
        }
        throw err;
      }
      // AutoRemove 的移除在 kill 之后异步完成：短暂等待容器消失，
      // 保证 stop 返回后 status() 立即为 null（最多 ~2s，超时则交由 daemon 收尾）
      for (let i = 0; i < 10 && (await inspectOrNull(name)) !== null; i++) {
        await sleep(200);
      }
    },

    async status(name) {
      const info = await inspectOrNull(name);
      if (!info) return null;
      return {
        name: info.Name.replace(/^\//, ""),
        id: info.Id.slice(0, 12),
        state: info.State.Running ? "running" : info.State.Status === "created" ? "created" : "exited",
        startedAt: info.State.StartedAt || null,
        labels: info.Config.Labels ?? {},
      };
    },

    async isRunning(name) {
      return (await this.status(name))?.state === "running";
    },

    async logs(name, tail = 100) {
      let buffer: Buffer;
      try {
        // follow:false → dockerode 收完整响应体（复用帧原始 Buffer）
        buffer = await docker.getContainer(name).logs({ stdout: true, stderr: true, tail, follow: false });
      } catch (err) {
        // 与 mock 对齐：容器已移除 → 日志随之消失，返回空串
        if (isStatus(err, 404)) return "";
        throw err;
      }
      const { stdout, stderr } = await demuxToString(docker, Readable.from(buffer), 2_000);
      return stdout + stderr;
    },

    async stats(name) {
      let frame: dockerode.ContainerStats;
      try {
        // stream:false → dockerode 收单帧 JSON（≈ docker stats --no-stream，
        // precpu_stats 即帧内自带的上一采样点，CPU% 可直接算）
        frame = await docker.getContainer(name).stats({ stream: false });
      } catch (err) {
        // 容器不存在 / 已移除（AutoRemove 下 stop 即 404）→ null；
        // 本适配器管理的容器只有 running 与"已消失"两态，无 exited 中间态
        if (isStatus(err, 404)) return null;
        throw err;
      }
      return containerStatsToSample(frame, Date.now());
    },

    async followLogs(name, onLine): Promise<FollowLogsHandle> {
      let stream: NodeJS.ReadableStream;
      try {
        stream = await docker.getContainer(name).logs(buildFollowLogOptions());
      } catch (err) {
        // 容器不存在（未创建/已移除）→ 静默空句柄（对齐 mock：日志随容器消失）
        if (isStatus(err, 404)) return idleFollowHandle();
        throw err;
      }

      // 复用流拆包：stdout/stderr 各接一个行分割器（两路独立缓冲，
      // 互不把对方的半行拼进来），行级增量回调 onLine——不是收尾拼接
      const out = new PassThrough();
      const errOut = new PassThrough();
      const outLines = new LineSplitter(onLine);
      const errLines = new LineSplitter(onLine);
      out.on("data", (chunk: Buffer) => outLines.push(chunk));
      errOut.on("data", (chunk: Buffer) => errLines.push(chunk));
      docker.modem.demuxStream(stream, out, errOut);

      // cleanup：流自然 end / close / error 都视为收完——flush 残留尾行后放行 stop 的等待
      let settled = false;
      let release: () => void;
      const cleaned = new Promise<void>((resolve) => (release = resolve));
      const finish = () => {
        if (settled) return;
        settled = true;
        outLines.flush();
        errLines.flush();
        release();
      };
      stream.on("end", finish);
      stream.on("close", finish);
      stream.on("error", finish);

      let stopped = false;
      return {
        stop: async () => {
          if (stopped) return; // 幂等：重复 stop 直接返回
          stopped = true;
          // follow 返回的是 hijack 后的 net.Socket（类型上只有 ReadableStream），鸭子类型销毁
          (stream as { destroy?: () => void }).destroy?.();
          await cleaned; // 等 destroy 触发的 close/error 走完 cleanup
        },
      };
    },

    async followStats(name, onSample): Promise<FollowLogsHandle> {
      let stream: NodeJS.ReadableStream;
      try {
        // stream:true → dockerode 直接给原始可读流：docker stats 的流式响应
        // 是逐行 JSON（不像 logs/attach 那样要 demuxStream 拆复用），
        // 但 chunk 边界与 JSON 帧边界不对齐，仍需按行切分
        stream = await docker.getContainer(name).stats({ stream: true });
      } catch (err) {
        if (isStatus(err, 404)) return idleFollowHandle();
        throw err;
      }

      // 首帧 precpu_stats 为空、CPU% 算不出：跳过第一帧不产样本
      let isFirstFrame = true;
      const splitter = new LineSplitter((line) => {
        if (line.trim() === "") return;
        let frame: dockerode.ContainerStats;
        try {
          frame = JSON.parse(line);
        } catch {
          return; // 半帧噪声（理论上不该发生，仍防御性丢弃）
        }
        if (isFirstFrame) {
          isFirstFrame = false;
          return;
        }
        onSample(containerStatsToSample(frame, Date.now()));
      });
      stream.on("data", (chunk: Buffer) => splitter.push(chunk));

      // cleanup：与 followLogs 同款——end/close/error 都视为收完
      let settled = false;
      let release: () => void;
      const cleaned = new Promise<void>((resolve) => (release = resolve));
      const finish = () => {
        if (settled) return;
        settled = true;
        splitter.flush();
        release();
      };
      stream.on("end", finish);
      stream.on("close", finish);
      stream.on("error", finish);

      let stopped = false;
      return {
        stop: async () => {
          if (stopped) return; // 幂等
          stopped = true;
          (stream as { destroy?: () => void }).destroy?.();
          await cleaned;
        },
      };
    },

    async list(filter) {
      const infos = await docker.listContainers({
        all: false,
        filters: filter?.label ? { label: [filter.label] } : {},
      });
      return infos.map((info) => ({
        name: (info.Names[0] ?? "").replace(/^\//, ""),
        id: info.Id.slice(0, 12),
        // listContainers 只返回运行中容器（all:false），State 字段粗粒度，统一记 running
        state: "running" as const,
        // 该 API 不提供 StartedAt，置 null；调用方（当前模型判定）只依赖 labels
        startedAt: null,
        labels: info.Labels ?? {},
      }));
    },

    pullImage,
  };
}
