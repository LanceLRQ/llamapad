import { buildExtractPrompt } from "./prompt";
import { LlmError, buildRequestBody, streamCompletions, type ExtractEngine } from "./engine";

/**
 * 外部 OpenAI 兼容引擎（批 3）
 *
 * **必须走出站代理**：实测直连某些 provider 会 60 秒超时，经代理立刻通。
 * 调用方（extract.ts）负责把 `makeProxyFetch` 产出的 fetch 传进来——这里
 * 只认一个 `doFetch`，不自己碰代理配置，好让单测能注入桩。
 */
export interface ExternalConfig {
  baseUrl: string | null;
  apiKey: string | null;
  model: string | null;
  extraBody: Record<string, unknown> | null;
}

export function createExternalEngine(config: ExternalConfig, doFetch: typeof fetch): ExtractEngine {
  const { baseUrl, apiKey, model } = config;
  if (baseUrl === null || apiKey === null || model === null) {
    throw new LlmError("notConfigured", "外部 API 还没配置完整");
  }

  return {
    id: "external",
    model,
    run: (input) =>
      streamCompletions(
        `${baseUrl.replace(/\/+$/, "")}/chat/completions`,
        { authorization: `Bearer ${apiKey}` },
        buildRequestBody(model, buildExtractPrompt(input.text), config.extraBody),
        doFetch,
        input,
      ),
  };
}
