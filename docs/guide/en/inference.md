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

This path also has a shorter alias, `/llama-proxy/*` — both forward to the same entry point, with identical authentication, error codes, and response bodies. The long form keeps working; the short form is the one to prefer when connecting a client, and the examples in "Connecting a client" below all use it.

### Authentication

- **Same-origin requests** (the Playground in a browser) carry the session cookie automatically and just work;
- **Scripts / external clients** use `Authorization: Bearer lp_…` — tokens are issued under Settings → Account & data → Account & security (the plaintext is shown only once, at the moment it's issued).

**Note: the `x-api-key` header is not accepted.** This is how the official Anthropic SDK sends credentials by default (via the `ANTHROPIC_API_KEY` environment variable), but the panel currently only recognizes the session cookie or `Authorization: Bearer`. When integrating with the official Anthropic SDK, you need to explicitly configure it to send a custom `Authorization` header instead (e.g. `ANTHROPIC_AUTH_TOKEN`), or use a client that supports custom request headers.

### Supported protocols

llama.cpp upstream already natively implements three protocol entry points, and the panel is a **transparent relay** for all three paths — it doesn't parse or rewrite the request or response body (the one exception is covered in "Reasoning-effort relay mapping" below); all protocol translation happens entirely inside llama.cpp:

| Protocol | Path via the panel |
| --- | --- |
| OpenAI Chat Completions | `/llama-proxy/v1/chat/completions` |
| OpenAI Responses | `/llama-proxy/v1/responses` |
| Anthropic Messages | `/llama-proxy/v1/messages` |

All three can be used directly, with no protocol conversion needed from the panel. Watch for differences in upstream maturity: the Responses protocol upstream **explicitly rejects** `previous_response_id` (server-side multi-turn state) — sending that field returns a 400 rather than being silently ignored; `store` is the one that neither errors nor takes effect (nothing is stored server-side, and there are no endpoints to read or delete a stored response). The Anthropic Messages protocol has more complete support (tool calls, thinking blocks, and streaming events have all been verified working), but error response bodies still have an OpenAI-style shape rather than the Anthropic spec's shape.

### Streaming

Both the request body and the response body are streamed through as-is, with no batching by the panel — response chunks arrive as they come, with no delay waiting to accumulate a batch before pushing it to the client.

### What the `model` field actually does under single-model semantics

llamapad only ever runs one model at a time, so the `model` field in a request body **doesn't participate in routing** — no matter what you put there, the request always goes to whichever model is currently running. The `model` field in responses, and the id shown by `GET /v1/models`, display the model name configured in the panel, not the GGUF file path inside the container; but this only affects the **echo**, not **routing** — sending the wrong `model` value still succeeds, it just goes to whichever model is currently running.

### Error shapes

Responses are always JSON. When no model is running you get 503 with `{"error":"没有运行中的模型","hint":"/models"}`; when the container is still up but its model config has been deleted, it's also 503, with the different text `{"error":"运行中模型的端口未知（模型配置缺失）","hint":"/models"}` — clients matching on the exact error string need to account for this second form.

When the container is up but llama-server hasn't started listening, you get 502 with `{"error":"容器端口未就绪"}`. This usually happens in the window right after a model starts — just retry; the window can last tens of seconds during a large model's cold start.

## Connecting a client

### Base URL and credentials

Every inference request goes to the same prefix:

```
http://<server-address>:28960/llama-proxy
```

Paths after this prefix map one-to-one onto llama-server's own API paths. So the base URL to give an OpenAI-compatible client is:

```
http://<server-address>:28960/llama-proxy/v1
```

The client appends `/chat/completions`, `/models` and so on itself. `/llama-proxy` is a short alias for `/api/v1/proxy/llama` — both forward to the same entry point and behave identically, so don't be thrown off if you see the long form elsewhere. A trailing slash on the base URL is harmless too: both a trailing slash and duplicated slashes inside the path are normalized with a 308 redirect that preserves the method and body, so any client that follows redirects won't notice the difference.

Credentials are issued under Settings → Account & data → Account & security — the same token you'd use for the panel's management endpoints (those are covered in [Panel API](./api.md)). The plaintext is shown only once at issuance; after that the list only keeps the last 4 characters for you to identify it by, so a lost token has to be revoked and reissued. Pass it in the `Authorization` header:

```
Authorization: Bearer lp_xxxxxxxx…
```

### Check connectivity with curl first

Before wiring up a third-party client, two commands confirm that the panel, the token and the model are all in order — and if something is wrong, they tell you immediately which part it is:

```bash
PANEL=http://<server-address>:28960
TOKEN=lp_xxxxxxxx

# 1. Model list: a data[] response means the token is valid and a model is running
curl -s "$PANEL/llama-proxy/v1/models" \
  -H "Authorization: Bearer $TOKEN"

# 2. A single non-streaming completion
curl -s "$PANEL/llama-proxy/v1/chat/completions" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Hello"}]}'
```

If the first command returns `{"error":"unauthorized"}`, the token is wrong. If it returns 503, no model is currently running — start one from the Models page.

For streaming, add `"stream": true` to the request body; the response is standard SSE:

```bash
curl -N "$PANEL/llama-proxy/v1/chat/completions" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Write a haiku"}],"stream":true}'
```

`-N` disables curl's own output buffering. Without it the content is flushed all at once at the end, which looks like streaming isn't working.

### OpenAI official SDK

Python:

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://<server-address>:28960/llama-proxy/v1",
    api_key="lp_xxxxxxxx",
)

resp = client.chat.completions.create(
    model="my-model",
    messages=[{"role": "user", "content": "Hello"}],
)
print(resp.choices[0].message.content)
```

Node:

```javascript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://<server-address>:28960/llama-proxy/v1",
  apiKey: "lp_xxxxxxxx",
});
```

The OpenAI SDK sends `api_key` as `Authorization: Bearer`, which is what the panel expects — no extra header configuration needed.

### Anthropic official SDK

Set the base URL to end at `/llama-proxy`; the SDK appends `/v1/messages` itself.

Credentials need one extra step: the Anthropic SDK sends credentials in an `x-api-key` header by default, which the panel does not accept. Use `auth_token` instead (environment variable `ANTHROPIC_AUTH_TOKEN`) — that one sends `Authorization: Bearer`:

```python
from anthropic import Anthropic

client = Anthropic(
    base_url="http://<server-address>:28960/llama-proxy",
    auth_token="lp_xxxxxxxx",
)
```

### Desktop clients and your own frontend

Cherry Studio, Open WebUI, LobeChat and similar clients all offer a custom provider entry for OpenAI-compatible endpoints. Three fields:

| Setting | What to enter |
| --- | --- |
| API address / Base URL | `http://<server-address>:28960/llama-proxy/v1` |
| API Key | the `lp_…` token issued by the panel |
| Model name | the id returned by `GET /v1/models` — that is, the model's name in the panel |

Clients differ on whether the base URL should end in `/v1`: some append it themselves, some expect you to type it out. If the model list won't load after saving, try adding or removing `/v1` and saving again.

Some clients read `supported_parameters` from the `GET /v1/models` response to work out which parameters a model accepts. The panel already fills in the reasoning-effort capability declaration there — see the next section.

### Things to know before connecting

**The `model` field can hold anything.** Using the id from `GET /v1/models` is the least surprising choice, and a wrong value won't error — see "What the `model` field actually does under single-model semantics" above for why.

**Cross-origin browser pages can't reach it.** The panel sends no CORS headers, so the relay is reachable only from same-origin pages (the panel's own Playground) and from server-side programs (curl, SDKs, desktop clients). To use it from your own web page, have that page's backend forward the request rather than calling from the browser.

**Expect 502 during the cold-start window.** Just after a model starts, the container is up but llama-server isn't listening yet, and the relay returns 502 for that period. On large models this can last tens of seconds; clients should retry rather than treat it as a configuration error.

**Concurrent requests share one model instance.** How many can be served at once depends on llama-server's own slot count; the panel neither queues nor rate-limits.

**Mind timeouts and buffering behind a reverse proxy.** nginx's default read timeout will cut off long responses, and its default buffering turns streaming into a single delayed response. See [HTTPS Reverse Proxy](./nginx.md) for a working configuration.

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
