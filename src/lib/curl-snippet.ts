/**
 * API 调用示例生成（UX P0 Task 6 / U8）：为运行中的 llama-server 生成
 * OpenAI 兼容端点的 curl 示例——开发者 persona 跑模型就是为了自己代码里
 * 调用，"复制即可用"省掉查端口/拼路径的往返。
 *
 * host 用浏览器当前 hostname（局域网 / SSH 隧道场景下天然正确：用户从哪
 * 访问面板，模型端口就以哪个主机名可达——部署上模型端口与面板同机暴露）。
 */

export function buildApiBaseUrl(host: string, port: number): string {
  return `http://${host}:${port}`;
}

/** 最小可跑通的 chat 请求示例（shell 续行符分行，粘贴即用） */
export function buildCurlCommand(host: string, port: number): string {
  return [
    `curl ${buildApiBaseUrl(host, port)}/v1/chat/completions \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{"messages":[{"role":"user","content":"Hello"}],"max_tokens":64}'`,
  ].join("\n");
}
