/**
 * 启动失败诊断映射（UX P0 Task 9 / U3）：把"启动失败/容器退出"的错误与
 * 日志文本翻译成"下一步建议"。运维面板的价值 = 坏了不用 SSH 上去查。
 *
 * 输入是拼接的错误体 + 日志尾行（服务端把容器尾日志嵌进启动错误消息，
 * 见 dockerode 适配器的"容器启动即退出"路径），匹配按子串大小写不敏感。
 * 真机样本对照见 07 计划风险簿（映射不中 → unknown 通用建议，不误导）。
 */

export type AdviceKind = "oom" | "portInUse" | "imageMissing" | "fileMissing" | "unknown";

interface Pattern {
  kind: Exclude<AdviceKind, "unknown">;
  regex: RegExp;
}

/** 匹配优先级从上到下（端口冲突会让容器秒退，先于通用 OOM 文本判断） */
const PATTERNS: Pattern[] = [
  {
    kind: "portInUse",
    // docker: "driver failed programming external connectivity ... bind: address already in use"
    regex: /address already in use|port is already allocated|bind:\s*address already/i,
  },
  {
    kind: "fileMissing",
    // 面板服务端启动校验（runtime.ts）的固定文案；docker/open 的 ENOENT 行
    regex: /模型文件缺失|\.gguf.*(no such file|not found)|no such file or directory.*\.gguf/i,
  },
  {
    kind: "imageMissing",
    // docker pull 404 / registry 权限
    regex: /manifest unknown|pull access denied|no such image|image .*not found|repository does not exist/i,
  },
  {
    kind: "oom",
    // CUDA OOM / KV cache 分配失败 / cgroup 内存超限
    regex: /out of memory|cuda error.*memory|cudamalloc failed|failed to allocate|outofmemoryerror|cgroup .*memory/i,
  },
];

export function diagnoseStartFailure(text: string): AdviceKind {
  for (const { kind, regex } of PATTERNS) {
    if (regex.test(text)) return kind;
  }
  return "unknown";
}
