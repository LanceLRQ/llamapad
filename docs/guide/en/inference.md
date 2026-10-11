# Inference Interface

## Playground

The Chat page (`/chat`) is the panel's own built-in conversation UI. The Playground only renders once a model is running and ready; while the container is up but hasn't passed its readiness probe yet, a loading state is shown instead, so requests never get sent to a port that isn't ready.

When several models are running, a model dropdown appears in the page header, with the default model selected when the page opens. Switching models clears the current conversation, and the parameter bar, port, and "Copy API usage example" all follow the new selection. If the model you're chatting with is stopped, the page switches back to the default model and tells you so.

The panel's built-in Playground **never sends any sampling parameters on its own**: the request body only ever has `model`, `messages`, and `stream`, where `model` only picks which model gets the request and isn't a sampling parameter. llama.cpp's bundled web UI stores its sampling parameter config in the `localStorage` of the `:18080` origin (llama-server's own port), which the panel can neither read nor write across origins; by simply never sending sampling parameters itself, the panel sidesteps this mismatch entirely; the defaults already set in the model's template and config take effect as normal.

The header's "Open llama UI" button is a supplementary entry point to llama.cpp's bundled web UI (opens in a new tab, not through the panel's reverse proxy). Its target address comes from one of two sources:

- `panel.yaml`'s `chat.base_url`, if explicitly configured, takes priority;
- otherwise, derived from the browser's current address as `http://<hostname>:<the running model's host port>`.

Most setups don't need to configure `chat.base_url`; the panel and llama-server's ports are published on the same host machine, so the hostname the browser uses to reach the panel is naturally also llama-server's hostname. You only need to explicitly set a reachable address in `panel.yaml` when this external-link button's target domain has HSTS enabled, causing the browser to force-upgrade the plain `http://` address to `https://` and fail to connect.

## Relay endpoint `/api/v1/proxy/llama/*`

The panel forwards the currently running container's llama-server API through the same-origin path `/api/v1/proxy/llama/*`; this is the panel's only inference relay entry point, and the Playground itself goes through this same path. Its purpose is to **collapse two ports into one**: SSH tunnels and reverse-proxy setups only need to expose this one panel port, without having to also open a hole for llama-server.

This path also has a shorter alias, `/llama-proxy/*`; both forward to the same entry point, with identical authentication, error codes, and response bodies. The long form keeps working; the short form is the one to prefer when connecting a client, and the examples in "Connecting a client" below all use it.

### Authentication

- **Same-origin requests** (the Playground in a browser) carry the session cookie automatically and just work;
- **Scripts / external clients** use `Authorization: Bearer lp_…`; tokens are issued under Settings → Account & data → Account & security (the plaintext is shown only once, at the moment it's issued).

**Note: the `x-api-key` header is not accepted.** This is how the official Anthropic SDK sends credentials by default (via the `ANTHROPIC_API_KEY` environment variable), but the panel currently only recognizes the session cookie or `Authorization: Bearer`. When integrating with the official Anthropic SDK, you need to explicitly configure it to send a custom `Authorization` header instead (e.g. `ANTHROPIC_AUTH_TOKEN`), or use a client that supports custom request headers.

### Supported protocols

llama.cpp upstream already natively implements three protocol entry points, and the panel is a **transparent relay** for all three paths: it doesn't parse or rewrite the request or response body (the one exception is covered in "Reasoning-effort relay mapping" below); all protocol translation happens entirely inside llama.cpp:

| Protocol | Path via the panel |
| --- | --- |
| OpenAI Chat Completions | `/llama-proxy/v1/chat/completions` |
| OpenAI Responses | `/llama-proxy/v1/responses` |
| Anthropic Messages | `/llama-proxy/v1/messages` |

All three can be used directly, with no protocol conversion needed from the panel. Watch for differences in upstream maturity: the Responses protocol upstream **explicitly rejects** `previous_response_id` (server-side multi-turn state); sending that field returns a 400 rather than being silently ignored; `store` is the one that neither errors nor takes effect (nothing is stored server-side, and there are no endpoints to read or delete a stored response). The Anthropic Messages protocol has more complete support (tool calls, thinking blocks, and streaming events have all been verified working), but error response bodies still have an OpenAI-style shape rather than the Anthropic spec's shape.

### Streaming

Both the request body and the response body are streamed through as-is, with no batching by the panel: response chunks arrive as they come, with no delay waiting to accumulate a batch before pushing it to the client.

### The `model` field decides which model gets the request

The panel can run several models at once, and the relay uses the request's `model` field to pick one:

| `model` in the request | Goes to |
| --- | --- |
| The name of a running model | That model |
| The name or an alias of an external upstream | That upstream (see "External upstreams" below) |
| Missing or empty | The default model |
| A model configured in the panel that isn't running | Not forwarded; returns 404 (see Error shapes below) |
| A name the panel doesn't know (e.g. a client hard-coding `gpt-4o`) | The default model |

GET-style requests (`/props`, `/health`, `/slots` and so on) have no body; use the `?model=` query parameter instead. When the request body is larger than 64MB the panel aborts reading and returns 413 (see Error shapes below) instead of silently treating the request as having no `model`.

Every response carries two diagnostic headers: `x-llamapad-model` is the model the request actually went to, and `x-llamapad-model-route` says why (`requested` for an explicit model, `default` when none was given, `fallback-default` when the name wasn't recognized, `fallback-unreachable` when the default external upstream is unreachable and the request was temporarily redirected to a managed model; see "External upstreams" below).

`GET /v1/models` is assembled by the panel from every running model that's already responding, in standard OpenAI format, with the default model first; each `id` is the model name in the panel. Models still loading aren't listed; with no model running you get an empty list.

### Error shapes

Responses are always JSON. When no model is running you get 503 with `{"error":"没有运行中的模型","hint":"/models/profiles"}`; when the container is still up but its model config has been deleted, it's also 503, with the different text `{"error":"运行中模型的端口未知（模型配置缺失）","hint":"/models/profiles"}`; clients matching on the exact error string need to account for this second form.

If the request's `model` names a model configured in the panel that isn't running, you get 404 with an OpenAI-style error body: `{"error":{"message":"模型 qwen3-8b 没有在运行，请先在面板里启动它","type":"invalid_request_error","code":"model_not_running"}}`.

When the container is up but llama-server hasn't started listening, you get 502 with `{"error":"容器端口未就绪"}`. This usually happens in the window right after a model starts, so just retry; the window can last tens of seconds during a large model's cold start.

When the request body exceeds 64MB, you get 413 with an OpenAI-style error body: `{"error":{"message":"请求体超过 64MB 上限","type":"invalid_request_error","code":"request_too_large"}}`.

## External upstreams

Besides relaying the llama.cpp models it starts itself, the panel can relay OpenAI-compatible services that are already deployed elsewhere, such as an inference engine on another machine. These are called external upstreams: the panel doesn't start or stop them, it only forwards requests to them.

### Registering

On the "API Relay" page, click "Add upstream" in the "External upstreams" area:

| Field | Description |
| --- | --- |
| Name | The name you put in the `model` field of a request; it can't be changed after saving. Letters (either case), digits and `.` `_` `-` only (no `/` or `:`), starting with a letter or digit, up to 128 characters, case-sensitive; it can't collide with an existing model config or upstream, and `test` and `probe` are reserved |
| Upstream URL | Up to, but not including, `/v1`, e.g. `http://192.168.1.10:8080`. Only `http` and `https` are supported. A trailing `/v1`, trailing slashes, a query string and a username/password in the URL are stripped on save |
| API key | Fill in if the upstream requires authentication. The panel puts it in the `Authorization: Bearer` header when forwarding. Visible ASCII characters only: no whitespace, line breaks or non-ASCII characters, otherwise saving is rejected |
| Upstream model name | If set, the request's `model` is replaced with it when forwarding; leave it empty if the upstream doesn't validate `model` |
| Aliases | Optional; lets clients reach this upstream under other names, see "Aliases" below |

You can click "Test connection" before saving. The panel requests the upstream's `/v1/models` and lists the model names it returns; click one to fill it into "Upstream model name"; the "Upstream model name" boxes of the alias rows also offer these names as suggestions.

### Requests

Just like requesting a managed model, put the registered name in `model`:

```bash
curl http://<server-address>:28960/llama-proxy/v1/chat/completions \
  -H "Authorization: Bearer lp_xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"strata","messages":[{"role":"user","content":"Hello"}]}'
```

The header carries the panel's token, not the upstream's key. The path is forwarded as-is, so other compatible endpoints the upstream supports (such as `/v1/messages` and `/v1/responses`) work too. `GET /v1/models` includes external upstreams that are enabled and not judged unreachable.

Requests to an external upstream get no reasoning-effort mapping; `reasoning_effort` is passed to the upstream unchanged.

### Aliases

The `model` a client has hard-coded often isn't the upstream's real model name. Attach aliases to an upstream, and a request that names an alias goes to that upstream, with `model` replaced by the upstream model name the alias maps to. For example, give upstream `strata` two aliases, `gpt-4.1` and `qwen-flash`, both targeting `qwen3.8-flash-next-iq3_s`:

```bash
curl http://<server-address>:28960/llama-proxy/v1/chat/completions \
  -H "Authorization: Bearer lp_xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4.1","messages":[{"role":"user","content":"Hello"}]}'
```

This request goes to `strata`, and the upstream receives `model` as `qwen3.8-flash-next-iq3_s`. Several aliases can point at the same target. Aliases are managed in the "Aliases" area when adding or editing an upstream; each row has an "Alias" and an "Upstream model name" (optional).

Rules:

- An alias may contain only letters, digits and `. _ : / -`, must start with a letter or digit, and is at most 128 characters long. It is case-sensitive. An upstream can have at most 50 aliases, with no duplicates within one upstream.
- Aliases are globally unique: an alias can't equal the name of any model config, the name of any upstream, or another alias, nor the name of the upstream it belongs to. Conversely, a new model config or upstream can't take a name that is already an alias.
- The `model` sent upstream is chosen in this order: the alias's own upstream model name; otherwise the upstream's "Upstream model name"; otherwise it is forwarded unchanged, i.e. the alias itself.
- An alias follows the upstream it belongs to: while the upstream is enabled, the alias reaches it; while it is disabled, naming the alias returns 404 `upstream_disabled`, just like naming the upstream. Aliases don't affect liveness probing, which is per upstream.
- An alias can't be set as the default model; only the upstream itself can.
- For an upstream that is enabled and not judged unreachable, its aliases are listed in `GET /v1/models` right after the upstream's own entry, also with `owned_by` set to `external`.
- The `x-llamapad-model` response header reports the upstream name, not the alias.

### Setting as default

An external upstream can be made the default model. The choice is saved and survives a panel restart, and starting a managed model afterwards doesn't change it. Setting a managed model as the default again, or deleting the upstream, clears the setting and returns the default to the usual rule (the earliest-started managed model); disabling the upstream only lets go of the default temporarily, and it becomes the default again once re-enabled.

### Health state

| State | Meaning |
| --- | --- |
| Unknown | The panel just started or the upstream was just registered, and it hasn't been probed yet. Requests are forwarded as usual |
| Reachable | Connections succeed. The panel probes it every 15 seconds |
| Unreachable | 3 consecutive connection failures. The panel stops probing it on a timer |
| Disabled | The switch is off. A request that names it gets 404 with the error code `upstream_disabled` |

An upstream counts as reachable as long as it returns an HTTP response, including 401 and 500: a wrong key won't make it unreachable.

An unreachable upstream is no longer probed on a timer; it is checked again once when any of these happens: a request names it, a default request would have gone to it, someone opens the "API Relay" page, or someone clicks "Test connection".

When the default upstream is unreachable:

- A managed model is running: requests without `model` are temporarily redirected to the managed model, and the `x-llamapad-model-route` response header is `fallback-unreachable`. Once the upstream recovers traffic switches back automatically; the first request after recovery still lands on the managed model.
- No managed model is running: requests are still sent to the upstream, and the client gets 502.

A request that names an upstream in `model` always goes to it and is never redirected.

A slow-starting service is judged unreachable while it loads. If you don't want default requests to land on a managed model during that time, don't make it the default; have clients write `model` explicitly.

### Limitations

- The Chat page can't select an external upstream.
- External upstreams have no monitoring charts and take no part in VRAM checks.
- External upstream settings are not in the config export; to back them up, back up `panel.db`.

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

The client appends `/chat/completions`, `/models` and so on itself. `/llama-proxy` is a short alias for `/api/v1/proxy/llama`; both forward to the same entry point and behave identically, so don't be thrown off if you see the long form elsewhere. A trailing slash on the base URL is harmless too: both a trailing slash and duplicated slashes inside the path are normalized with a 308 redirect that preserves the method and body, so any client that follows redirects won't notice the difference.

Credentials are issued under Settings → Account & data → Account & security; the same token you'd use for the panel's management endpoints (those are covered in [Panel API](./api.md)). The plaintext is shown only once at issuance; after that the list only keeps the last 4 characters for you to identify it by, so a lost token has to be revoked and reissued. Pass it in the `Authorization` header:

```
Authorization: Bearer lp_xxxxxxxx…
```

### Check connectivity with curl first

Before wiring up a third-party client, two commands confirm that the panel, the token and the model are all in order, and if something is wrong, they tell you immediately which part it is:

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

If the first command returns `{"error":"unauthorized"}`, the token is wrong. If it returns 503, no model is currently running; start one from the Models page.

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

The OpenAI SDK sends `api_key` as `Authorization: Bearer`, which is what the panel expects; no extra header configuration needed.

### Anthropic official SDK

Set the base URL to end at `/llama-proxy`; the SDK appends `/v1/messages` itself.

Credentials need one extra step: the Anthropic SDK sends credentials in an `x-api-key` header by default, which the panel does not accept. Use `auth_token` instead (environment variable `ANTHROPIC_AUTH_TOKEN`); that one sends `Authorization: Bearer`:

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
| Model name | the id returned by `GET /v1/models`, that is, the model's name in the panel |

Clients differ on whether the base URL should end in `/v1`: some append it themselves, some expect you to type it out. If the model list won't load after saving, try adding or removing `/v1` and saving again.

Some clients read `supported_parameters` from the `GET /v1/models` response to work out which parameters a model accepts. The panel already fills in the reasoning-effort capability declaration there; see the next section.

### Things to know before connecting

**Put the id from `GET /v1/models` in the `model` field.** It decides which model handles the request; a name the panel doesn't know falls back to the default model, and a configured model that isn't running gets 404. See "The `model` field decides which model gets the request" above.

**Cross-origin browser pages can't reach it.** The panel sends no CORS headers, so the relay is reachable only from same-origin pages (the panel's own Playground) and from server-side programs (curl, SDKs, desktop clients). To use it from your own web page, have that page's backend forward the request rather than calling from the browser.

**Expect 502 during the cold-start window.** Just after a model starts, the container is up but llama-server isn't listening yet, and the relay returns 502 for that period. On large models this can last tens of seconds; clients should retry rather than treat it as a configuration error.

**Concurrent requests to the same model share one model instance.** How many can be served at once depends on llama-server's own slot count; the panel neither queues nor rate-limits.

**Mind timeouts and buffering behind a reverse proxy.** nginx's default read timeout will cut off long responses, and its default buffering turns streaming into a single delayed response. See [HTTPS Reverse Proxy](./nginx.md) for a working configuration.

## Reasoning-effort relay mapping

Different models' packaged chat templates accept different `reasoning_effort` value ranges (for example, some Qwen3-family templates only recognize `xhigh` / `medium` / `low`); `high` / `max` / `minimal`, values clients commonly send, would make llama-server throw an HTTP 500 directly on these templates, and since the container itself starts up and passes its health check normally regardless, this only surfaces once you actually send an inference request carrying that value. To make sure clients work no matter what value they send, the panel automatically rewrites this value when relaying a request.

**Trigger conditions**: rewriting only happens when all three are true: it's a POST request, `Content-Type` is `application/json`, and the path matches an allowlist (`v1/chat/completions`, `chat/completions`, `apply-template`); `GET` requests, non-JSON bodies, and paths outside the allowlist are always passed through unchanged.

**Rewrite rules** (evaluated in order, stopping at the first match):

1. Value is `"none"`: passed through as-is (llama.cpp treats it as "thinking off");
2. Matches this model's explicit alias table in its API config: use the alias's result;
3. Already within this model's template-supported value range: passed through as-is;
4. Whether this model supports `reasoning_effort` is unknown (no GGUF-embedded template, or the template doesn't read this variable): passed through as-is; with no basis for a decision, nothing is changed;
5. Out of range, and the configured rounding direction is `off`: the field is dropped, letting the template fall back to its own default;
6. Value isn't on the ladder (`minimal < low < medium < high < xhigh < max`): the field is dropped;
7. Round to the nearest level: per the configured direction (`down`/`up`), find the closest level within this model's supported range.

The panel determines whether a model supports `reasoning_effort` based on whether the GGUF-embedded chat template reads the `reasoning_effort` or `reasoning_strength` variable name; when it can't tell, it falls under rule 4 and passes the value through as-is with no range validation.

**Diagnostic info**: when a rewrite happens, the response carries an `x-llamapad-reasoning-effort` header shaped like `high->xhigh (alias)` or `banana->dropped (unsupported)`, so you can see both the client's original value and the final decision in that header.

**Size limit**: the body is measured by the bytes actually read (not the `content-length` header); once it exceeds 64MB the panel aborts reading and returns 413 (OpenAI-style error, `code: request_too_large`) instead of forwarding the request.

**`GET /v1/models` enhancement**: the panel injects `supported_parameters` (whether `reasoning_effort` is supported) and `x_llamapad.reasoning_effort` (containing `supported` / `levels` / `aliases` / `rounding`) into every item of the upstream's `data[]` array, so clients like Cherry Studio can use it to decide what value to send for that model. This is the one and only path where the panel buffers and rewrites a response body (every other path streams the response through directly).

The model-level fixed `reasoning_effort` config (as opposed to the per-request dynamic rewriting in this section) is covered in [Model Configuration](./models.md).

## Known limitations

The `dry_penalty_last_n` parameter in llama.cpp's bundled web UI errors when set to `-1`: newer versions of llama-server validate that this value must be `≥0`, causing chat requests to return 400. This setting lives in `localStorage` on llama-server's own origin, which the panel can't reach or change across origins; it can only be fixed by hand in the bundled web UI's own settings. See [Troubleshooting](./troubleshooting.md) for details.
