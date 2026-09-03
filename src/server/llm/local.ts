import { llamaUpstreamBase } from "../llamaProxy";
import type { RunningContainerInfo } from "../runtime";
import { buildExtractPrompt } from "./prompt";
import { LlmError, buildRequestBody, streamCompletions, type ExtractEngine } from "./engine";

/**
 * 本地引擎：直连当前运行中的 llama-server（批 3）
 *
 * 不经浏览器那条 `/api/v1/proxy/llama` 反代——那是给前端用的，服务端自己调用
 * 绕一圈只会多一跳。目标地址复用 `llamaUpstreamBase`，与反代 route、health
 * 采集器共用同一个拼法，三处必须一致（容器化部署时 host 是 host.docker.internal
 * 而不是 127.0.0.1，这个差异只在那一个函数里）。
 *
 * **不带 authorization**：面板的 session cookie 与 API token 都不该泄漏给模型
 * 容器，而且 llama-server 自己的 `--api-key` 校验会与之冲突（反代那边
 * REQUEST_STRIP_HEADERS 剔除 authorization 就是这个理由）。
 *
 * **会占用正在运行的模型一次推理**，与 Playground 抢槽位。UI 上必须明示。
 */
export function createLocalEngine(
  running: RunningContainerInfo | null,
  extraBody: Record<string, unknown> | null,
  doFetch: typeof fetch,
): ExtractEngine {
  if (running === null || running.hostPort === null) {
    throw new LlmError("noRunningModel", "当前没有模型在运行");
  }

  const model = running.model;
  return {
    id: "local",
    model,
    run: (input) =>
      streamCompletions(
        `${llamaUpstreamBase(running.hostPort!)}/v1/chat/completions`,
        {},
        buildRequestBody(model, buildExtractPrompt(input.text), extraBody),
        doFetch,
        input,
      ),
  };
}
