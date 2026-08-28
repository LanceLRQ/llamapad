import { ProxyAgent } from "undici";

/**
 * ProxyAgent 复用缓存（hf/client.ts 与 download/manager.ts 共用）。
 *
 * 背景：undici 的 ProxyAgent 内部持 keep-alive 连接池，而全库此前零
 * `.close()`/`.destroy()` 调用——hf/client.ts 每次 fetch 都 new 一个，
 * download/manager.ts 每个下载任务也 new 一个，连接池只增不回收。
 * panel.yaml 的 proxy 是全局单值配置，任意时刻只有一个"当前生效" uri，
 * 因此按 uri 做单槽缓存即可：同 uri 复用同一实例；uri 变化（即面板配置
 * 被改）说明旧值不再被任何调用方引用，此时关闭旧实例再建新的，避免
 * 把"每次请求泄漏一个"的问题变成"每次改配置泄漏一个"。
 *
 * 用 close() 而非 destroy()：查 node_modules/undici/types/proxy-agent.d.ts，
 * ProxyAgent 自身只声明了 `close(): Promise<void>`（等在途请求结束后再释放
 * 连接池），destroy 是继承自 Dispatcher 的硬中断（立即 abort 在途请求）。
 * 配置变更时旧实例可能仍有请求在飞（如一次 HF 列文件正在走旧代理），
 * close 能让它们体面收尾，没有必要用 destroy 打断。
 *
 * 挂载 globalThis：Next 把 route handler 编译成不同 bundle，模块级变量
 * 不跨 bundle 共享（locators.ts 的 globalForMetrics 同款结论——各 bundle
 * 各持一份会导致同一进程里出现多个 ProxyAgent，缓存形同虚设），必须挂到
 * 全局才能保证 hf/client.ts 与 download/manager.ts 拿到同一实例。
 */

interface ProxyAgentCacheEntry {
  uri: string;
  agent: ProxyAgent;
}

const globalForProxyAgent = globalThis as typeof globalThis & {
  __llamapadProxyAgentCache?: ProxyAgentCacheEntry;
};

/**
 * 取（或按需创建）某代理 uri 对应的 ProxyAgent 单例。
 * uri 为空/未配置时返回 undefined（不创建实例），保住调用方原有的
 * `proxy ? new ProxyAgent(...) : undefined` 语义。
 */
export function getProxyAgent(uri: string | undefined): ProxyAgent | undefined {
  if (!uri) return undefined;

  const cached = globalForProxyAgent.__llamapadProxyAgentCache;
  if (cached && cached.uri === uri) {
    return cached.agent;
  }

  if (cached) {
    // 旧 uri 已不再是"当前配置"，没有调用方会再引用它，close 释放连接池；
    // 失败不影响新实例可用性，仅吞错（进程退出时连接池终归随之回收）。
    void cached.agent.close().catch(() => {});
  }

  const agent = new ProxyAgent({ uri });
  globalForProxyAgent.__llamapadProxyAgentCache = { uri, agent };
  return agent;
}

/** 仅测试用：清空单例缓存，保证用例间隔离（命名惯例同 panelConfig.ts 的 _resetPanelConfigForTest） */
export function _resetProxyAgentCacheForTest(): void {
  globalForProxyAgent.__llamapadProxyAgentCache = undefined;
}
