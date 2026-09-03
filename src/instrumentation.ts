/**
 * Next 启动钩子（`register()` 在每个 server 实例启动时跑一次）。
 * 目前只装关机兜底——理由与代价见 server/shutdownGuard.ts 头注释。
 *
 * 这里刻意只留一个动态 import：进程信号相关的 node API 全部住在被引入的
 * 服务端模块里，否则 Turbopack 会把它们当作 Edge Runtime 代码逐条告警。
 */
export async function register(): Promise<void> {
  // edge runtime 没有进程信号，也不是面板的运行形态，直接跳过
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { installShutdownGuard } = await import("./server/shutdownGuard");
  installShutdownGuard();

  // models 宿主机根自动发现（挂载表兜底，见 server/selfMounts.ts 头注释）：
  // 只有 env 与 panel.yaml 都没给出时才值得跑一次 docker inspect；已解析时
  // 白跑一次没有意义。失败绝不能拖垮面板启动——整段吞错，安静降级给 Doctor 报。
  try {
    const { getModelsHostSource, getPanelConfig, setDiscoveredModelsHost } = await import(
      "./server/panelConfig"
    );
    if (getModelsHostSource() === "unresolved") {
      const { getSharedDockerAdapter } = await import("./server/locators");
      const { discoverHostModelsRoot } = await import("./server/selfMounts");
      const hostPath = await discoverHostModelsRoot(
        getSharedDockerAdapter(),
        getPanelConfig().paths.models.panel,
      );
      if (hostPath !== null) setDiscoveredModelsHost(hostPath);
    }
  } catch (e) {
    console.warn("models 宿主机根自动发现失败，将由 Doctor 提示手工配置:", e);
  }

  // 可用导入源发现（本地权重迁移，见 server/mounts.ts 头注释）：读自身挂载表，
  // 供「自定义扫描目录」判断用户填的路径是否已挂进容器。与上面 models 根的
  // "unresolved 才查" 不同——即便 models 根已由 env/panel.yaml 给出，用户仍可能
  // 挂了别的导入源目录进来，所以每次启动都跑一次，不受上面的解析结果影响。
  try {
    const { getPanelConfig } = await import("./server/panelConfig");
    const { getSharedDockerAdapter } = await import("./server/locators");
    const { discoverImportableMounts, setDiscoveredMounts } = await import("./server/mounts");
    const maps = await discoverImportableMounts(
      getSharedDockerAdapter(),
      getPanelConfig().paths.models.panel,
    );
    setDiscoveredMounts(maps);
  } catch (e) {
    console.warn("可用导入源挂载表发现失败:", e);
  }
}
