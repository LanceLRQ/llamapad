# Inference Interface

## Playground

The Chat page (`/chat`) is the panel's own built-in conversation UI. The Playground only renders once a model is running and ready; while the container is up but hasn't passed its readiness probe yet, a loading state is shown instead — so requests never get sent to a port that isn't ready.

The panel's built-in Playground **never sends any sampling parameters on its own** — the request body only ever has `messages` and `stream`. llama.cpp's bundled web UI stores its sampling parameter config in the `localStorage` of the `:18080` origin (llama-server's own port), which the panel can neither read nor write across origins; by simply never sending sampling parameters itself, the panel sidesteps this mismatch entirely — the defaults already set in the model's template and config take effect as normal.

The header's "Open llama UI" button is a supplementary entry point to llama.cpp's bundled web UI (opens in a new tab, not through the panel's reverse proxy). Its target address comes from one of two sources:

- `panel.yaml`'s `chat.base_url`, if explicitly configured — takes priority;
- otherwise, derived from the browser's current address as `http://<hostname>:<the running model's host port>`.

Most setups don't need to configure `chat.base_url` — the panel and llama-server's ports are published on the same host machine, so the hostname the browser uses to reach the panel is naturally also llama-server's hostname. You only need to explicitly set a reachable address in `panel.yaml` when this external-link button's target domain has HSTS enabled, causing the browser to force-upgrade the plain `http://` address to `https://` and fail to connect.

## Relay endpoint `/api/v1/proxy/llama/*`

The panel forwards the currently running container's llama-server API through the same-origin path `/api/v1/proxy/llama/*` — this is the panel's only inference relay entry point, and the Playground itself goes through this same path. Its purpose is to **collapse two ports into one**: SSH tunnels and reverse-proxy setups only need to expose this one panel port, without having to also open a hole for llama-server.

### Authentication

- **Same-origin requests** (the Playground in a browser) carry the session cookie automatically and just work;
- **Scripts / external clients** use `Authorization: Bearer lp_…` — tokens are issued under "Settings → Account & security" (the plaintext is shown only once, at the moment it's issued).

**Note: the `x-api-key` header is not accepted.** This is how the official Anthropic SDK sends credentials by default (via the `ANTHROPIC_API_KEY` environment variable), but the panel currently only recognizes the session cookie or `Authorization: Bearer`. When integrating with the official Anthropic SDK, you need to explicitly configure it to send a custom `Authorization` header instead (e.g. `ANTHROPIC_AUTH_TOKEN`), or use a client that supports custom request headers.

### Supported protocols

llama.cpp upstream already natively implements three protocol entry points, and the panel is a **transparent relay** for all three paths — it doesn't parse or rewrite the request or response body (the one exception is covered in "Reasoning-effort relay mapping" below); all protocol translation happens entirely inside llama.cpp:

| Protocol | Path via the panel |
| --- | --- |
| OpenAI Chat Completions | `/api/v1/proxy/llama/v1/chat/completions` |
| OpenAI Responses | `/api/v1/proxy/llama/v1/responses` |
| Anthropic Messages | `/api/v1/proxy/llama/v1/messages` |

All three can be used directly, with no protocol conversion needed from the panel. Watch for differences in upstream maturity: the Responses protocol upstream explicitly doesn't support `previous_response_id` (server-side multi-turn state) or `store` — requesting these fields won't error, but they won't take effect either. The Anthropic Messages protocol has more complete support (tool calls, thinking blocks, and streaming events have all been verified working), but error response bodies still have an OpenAI-style shape rather than the Anthropic spec's shape.

### Streaming

Both the request body and the response body are streamed through as-is, with no batching by the panel — response chunks arrive as they come, with no delay waiting to accumulate a batch before pushing it to the client.

### What the `model` field actually does under single-model semantics

llamapad only ever runs one model at a time, so the `model` field in a request body **doesn't participate in routing** — no matter what you put there, the request always goes to whichever model is currently running. The `model` field in responses, and the id shown by `GET /v1/models`, display the model name configured in the panel, not the GGUF file path inside the container; but this only affects the **echo**, not **routing** — sending the wrong `model` value still succeeds, it just goes to whichever model is currently running.

### Error shapes

Responses are always JSON:

| Scenario | Status | Response body |
| --- | --- | --- |
| No model is running | 503 | `{"error":"没有运行中的模型","hint":"/models"}` |
| Container port not ready yet (common during the startup window) | 502 | `{"error":"容器端口未就绪"}` |

502 usually happens in the window right after a model starts, when the container is already up but llama-server hasn't started listening yet — just retry; this window can last tens of seconds during a large model's cold start.

## Reasoning-effort relay mapping

Different models' packaged chat templates accept different `reasoning_effort` value ranges (for example, some Qwen3-family templates only recognize `xhigh` / `medium` / `low`) — `high` / `max` / `minimal`, values clients commonly send, would make llama-server throw an HTTP 500 directly on these templates, and since the container itself starts up and passes its health check normally regardless, this only surfaces once you actually send an inference request carrying that value. To make sure clients work no matter what value they send, the panel automatically rewrites this value when relaying a request.

**Trigger conditions**: rewriting only happens when all three are true — it's a POST request, `Content-Type` is `application/json`, and the path matches an allowlist (`v1/chat/completions`, `chat/completions`, `apply-template`); `GET` requests, non-JSON bodies, and paths outside the allowlist are always passed through unchanged.

**Rewrite rules** (evaluated in order, stopping at the first match):

1. Value is `"none"`: passed through as-is (llama.cpp treats it as "thinking off");
2. Matches this model's explicit alias table in its API config: use the alias's result;
3. Already within this model's template-supported value range: passed through as-is;
4. Whether this model supports `reasoning_effort` is unknown (no GGUF-embedded template, or the template doesn't read this variable): passed through as-is — with no basis for a decision, nothing is changed;
5. Out of range, and the configured rounding direction is `off`: the field is dropped, letting the template fall back to its own default;
6. Value isn't on the ladder (`minimal < low < medium < high < xhigh < max`): the field is dropped;
7. Round to the nearest level: per the configured direction (`down`/`up`), find the closest level within this model's supported range.

The panel determines whether a model supports `reasoning_effort` based on whether the GGUF-embedded chat template reads the `reasoning_effort` or `reasoning_strength` variable name; when it can't tell, it falls under rule 4 and passes the value through as-is with no range validation.

**Diagnostic info**: when a rewrite happens, the response carries an `x-llamapad-reasoning-effort` header shaped like `high->xhigh (alias)` or `banana->dropped (unsupported)`, so you can see both the client's original value and the final decision in that header.

**Size limit**: when the request body exceeds 4MB (or is missing a `content-length` header, or its size can't be safely determined), rewriting is **skipped** and the request is passed through as-is. When skipped this way, the response header still reads `skipped (body too large)`, so the client doesn't mistake it for the field being silently ignored.

**`GET /v1/models` enhancement**: the panel injects `supported_parameters` (whether `reasoning_effort` is supported) and `x_llamapad.reasoning_effort` (containing `supported` / `levels` / `aliases` / `rounding`) into every item of the upstream's `data[]` array, so clients like Cherry Studio can use it to decide what value to send for that model. This is the one and only path where the panel buffers and rewrites a response body (every other path streams the response through directly).

The model-level fixed `reasoning_effort` config (as opposed to the per-request dynamic rewriting in this section) is covered in [Model Configuration](./models.md).

## Known limitations

The `dry_penalty_last_n` parameter in llama.cpp's bundled web UI errors when set to `-1`: newer versions of llama-server validate that this value must be `≥0`, causing chat requests to return 400. This setting lives in `localStorage` on llama-server's own origin, which the panel can't reach or change across origins — it can only be fixed by hand in the bundled web UI's own settings. See [Troubleshooting](./troubleshooting.md) for details.
