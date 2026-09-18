import net from "node:net";

/**
 * 宿主机端口占用探测（多模型并行，决策 D2：启动时端口被占自动顺延）
 *
 * 探测地址与反代、健康采集同源：PANEL_LLAMA_HOST，缺省 127.0.0.1（见
 * llamaProxy.ts 的 llamaUpstreamBase 注释）。面板容器化部署时它指向宿主机，
 * 所以这里看到的就是宿主机上的端口占用情况。
 *
 * 结果只有「确定被占」才返回 true。连接被拒、超时、DNS 失败都返回 false，
 * 这些情况交给 docker 自己的端口冲突报错去兜底（runtime.ts 识别后顺延重试），
 * 探测只是为了少走一次失败的容器创建，不是唯一防线。
 */

const DEFAULT_TIMEOUT_MS = 300;

export interface PortProbeOptions {
  host?: string;
  timeoutMs?: number;
}

export function createPortProbe(options: PortProbeOptions = {}): (port: number) => Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return (port) =>
    new Promise<boolean>((resolve) => {
      const host = options.host ?? process.env.PANEL_LLAMA_HOST ?? "127.0.0.1";
      const socket = net.createConnection({ host, port });
      let settled = false;
      const finish = (inUse: boolean) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(inUse);
      };
      socket.setTimeout(timeoutMs, () => finish(false));
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
    });
}
