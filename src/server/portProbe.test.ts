import { afterEach, describe, expect, it } from "vitest";
import net from "node:net";
import { createPortProbe } from "./portProbe";

let server: net.Server | null = null;

afterEach(async () => {
  if (server !== null) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
});

/** 在 127.0.0.1 随机端口起一个真实监听，返回端口号 */
async function listenOnRandomPort(): Promise<number> {
  server = net.createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
  return (server!.address() as net.AddressInfo).port;
}

describe("createPortProbe", () => {
  it("端口有进程监听 → true", async () => {
    const port = await listenOnRandomPort();
    const probe = createPortProbe({ host: "127.0.0.1" });
    await expect(probe(port)).resolves.toBe(true);
  });

  it("端口无人监听（连接被拒绝）→ false", async () => {
    const port = await listenOnRandomPort();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    const probe = createPortProbe({ host: "127.0.0.1" });
    await expect(probe(port)).resolves.toBe(false);
  });

  it("连接超时 → false（不可判定按空闲处理，交给 docker 报错兜底）", async () => {
    // 10.255.255.1 是不可路由地址，SYN 无应答，必然走超时分支
    const probe = createPortProbe({ host: "10.255.255.1", timeoutMs: 50 });
    await expect(probe(18080)).resolves.toBe(false);
  });
});
