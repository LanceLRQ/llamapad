/**
 * 模型配置表单的端口冲突提示（多模型并行，决策 D4）
 *
 * 只提示不拦截：端口相同的两个模型并不一定会同时运行，就算同时运行，
 * 后启动的那个也会在启动时自动顺延（lib/port-allocation.ts）。提示的作用是让用户
 * 知道「这个模型的实际端口可能不是这里填的值」，需要固定端口的话自己改一个。
 */

export interface PeerPort {
  /** 模型名 */
  name: string;
  /** 该模型合并配置后的 docker.host_port */
  hostPort: number;
}

/** 与 port 相同的其他模型名（排除 selfName）；port 为 null（草稿非法）时返回空数组 */
export function findPortPeers(port: number | null, selfName: string | null, peers: readonly PeerPort[]): string[] {
  if (port === null) return [];
  return peers.filter((peer) => peer.hostPort === port && peer.name !== selfName).map((peer) => peer.name);
}

const MAX_LISTED = 3;

/** 提示文案里最多列 3 个模型名，其余折成数量；分隔符随界面语言由调用方传入（中文顿号 / 英文逗号） */
export function formatPeerNames(names: readonly string[], separator: string): { names: string; more: number } {
  return {
    names: names.slice(0, MAX_LISTED).join(separator),
    more: Math.max(0, names.length - MAX_LISTED),
  };
}
