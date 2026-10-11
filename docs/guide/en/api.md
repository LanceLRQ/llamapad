# Panel API

Every action in the panel's UI is backed by an HTTP request, and these same endpoints can be called directly from a script. That makes them a good fit for scheduled backups, wiring model start/stop into your own ops workflow, or feeding download tasks and monitoring data into another system.

Inference requests go through a separate entry point; see [Inference Interface](./inference.md).

## General conventions

### Base URL

```
http://<server-address>:28960/api/v1
```

Paths shown in this document all omit this prefix. For example, "`GET /models`" means the full address `http://<server-address>:28960/api/v1/models`.

### Authentication

Issue an API Token under Settings → Account & data → Account & security; the plaintext is shown only once, at the moment it's issued. Send it in the `Authorization` header:

```bash
curl -s http://<server-address>:28960/api/v1/models \
  -H "Authorization: Bearer lp_xxxxxxxx"
```

A request that fails authentication always gets 401 `{"error":"unauthorized"}`.

Two exceptions are worth noting:

- **The three token-management endpoints don't accept token authentication.** The `/auth/tokens` group (list / issue / revoke) only recognizes a browser's logged-in session; calling them with `lp_…` gets 401. This way, even if a token leaks, whoever has it can't use it to issue new tokens or revoke someone else's.
- **The browser's `EventSource` can't send a Bearer header.** Its API doesn't support custom request headers, so it can only rely on a same-origin page's login state. To subscribe to SSE from a script, use an HTTP client that supports custom headers (`curl -N`, `fetch` with `ReadableStream`, Python's `httpx`, etc.).

Revoking a token takes effect immediately; the next request from a program still using it gets 401.

### Request & response format

Write requests have a JSON body and need `Content-Type: application/json`. Responses are always JSON.

Time fields come in two shapes, depending on the endpoint: most config-type endpoints use an ISO string (`2026-09-02T01:23:45.000Z`), while run history and monitoring data points use a millisecond timestamp number.

### Errors

An error response has the shape `{"error": "…"}`. When request body validation fails, it additionally carries an `issues` array pointing out which field the problem is in:

```json
{
  "error": "invalid_body",
  "issues": [{ "path": "name", "message": "..." }]
}
```

Common status codes:

| Status | Meaning |
| --- | --- |
| 400 | Invalid request body or parameters |
| 401 | Not authenticated, or credentials invalid |
| 404 | Target doesn't exist |
| 409 | Conflicts with current state (name collision, blocked while running, a start/stop operation already in progress) |
| 422 | Parameters are valid but the server refuses to act (model file missing at startup, or a `reasoning_effort` value the model's chat template won't accept) |
| 423 | Target is locked by a currently running model |
| 500 | Server error |

A few endpoints have their own status codes: queuing a download returns 507 when disk space is short, and the download-source connectivity test returns 502 on failure.

## Common tasks

The examples below all use these two variables:

```bash
PANEL=http://<server-address>:28960/api/v1
TOKEN=lp_xxxxxxxx
```

### Check which model is currently running

```bash
curl -s "$PANEL/runtime/status" -H "Authorization: Bearer $TOKEN"
```

```json
{
  "running": {
    "model": "qwen3-30b",
    "displayName": "Qwen3 30B",
    "container": "llama-server",
    "startedAt": "2026-09-02T01:20:00.000Z",
    "hostPort": 18080,
    "configuredHostPort": 18080,
    "configStale": false,
    "ready": true
  },
  "models": [
    {
      "model": "qwen3-30b",
      "displayName": "Qwen3 30B",
      "container": "llama-server",
      "startedAt": "2026-09-02T01:20:00.000Z",
      "hostPort": 18080,
      "configuredHostPort": 18080,
      "configStale": false,
      "ready": true
    },
    {
      "model": "qwen3-8b",
      "displayName": "Qwen3 8B",
      "container": "llama-server-qwen3-8b",
      "startedAt": "2026-09-02T01:25:00.000Z",
      "hostPort": 18081,
      "configuredHostPort": 18080,
      "configStale": false,
      "ready": false
    }
  ],
  "defaultModel": "qwen3-30b",
  "starting": []
}
```

`models` lists every running model, ordered by start time; `running` is the default model among them (API relay requests without a `model` field go to it). When no model is running, `running` is `null` and `models` is an empty array.

`defaultModel` can also be the name of an external upstream (when one has been set as the default); `running` still points at the default among the managed models. The added `upstreams` field summarizes every external upstream as `{ name, displayName, enabled, state }`, where `state` is `unknown` / `reachable` / `unreachable`. A disabled upstream always has `state` `unknown`; read `enabled` on the same item to tell whether it's disabled. The full state (including `disabled`) is in `GET /upstreams`.

With `?model=<model name>`, `running` becomes that model instead (`null` if it isn't running); scripts waiting for one particular model to become ready should use this. `hostPort` is the actual port: when several models run together, a port may have been shifted because of a clash, so it can differ from the configured `configuredHostPort`.

Two fields determine how you should write your script:

- **`ready`** tells you whether llama-server is actually able to accept requests yet. There's a window between the container coming up and it truly being ready (on a large model this can be tens of seconds) during which `ready` is `false`. Scripts checking "is the model usable yet" should look at this field, not just at whether `running` is non-null.
- **`configStale`** being `true` means this model's config was changed after it started, so it's currently running with the old parameters; a restart is needed for the new ones to take effect.

**`starting`** lists models that are starting or restarting, each shaped `{ model, displayName, action, since, stage }`. After a start request is sent and before it returns, the container may not exist yet (for example, the image isn't local and is being pulled), so `models` won't show it; check `starting` instead. `stage` goes `preparing` (validation, removing the old container), then `pulling` (pulling the image, skipped if it's already local), then `creating` (the container exists and is starting).

Once the start request returns, the model moves from `starting` to `models`, and whether it's usable is still decided by `ready`. For a few seconds after the container is created, the panel checks that it didn't exit right away; during that window the same model appears in both lists, which is expected. When several models start at once, `starting` has one entry for each.

Adding `?busy=1` returns an extra `busy` field, telling you whether it's currently generating content and how many slots are occupied. This requires an extra probe request to the model server, meant for scenarios like "restart once it's idle"; don't put it in a high-frequency poll.

`busy` being `null` means **couldn't be determined**, not idle; this is the value both when no model is running and when the probe request itself fails. Don't treat it as a green light in "wait until idle" logic.

### Start, stop and restart models

```bash
# Start (doesn't stop any other running model)
curl -s -X POST "$PANEL/models/qwen3-30b/start" -H "Authorization: Bearer $TOKEN"

# Stop
curl -s -X POST "$PANEL/models/qwen3-30b/stop" -H "Authorization: Bearer $TOKEN"

# Restart (to apply new parameters after a config change)
curl -s -X POST "$PANEL/models/qwen3-30b/restart" -H "Authorization: Bearer $TOKEN"
```

A successful start returns `{"id": "<container id>"}`; stop returns `{"ok": true}`.

Three things are easy to get wrong when scripting against this:

**A 200 response doesn't mean the model is usable yet.** The endpoint returns as soon as Docker has been told to start the container; the weights are still loading. To wait for it to actually be usable, poll `runtime/status` with `?model=` and check only `running.ready` (without the query param `running` is the default model; the response body's `models[]` still lists `ready` for every running model, so if another model happens to already be ready, a plain `grep '"ready":true'` matches on the very first poll):

```bash
curl -s -X POST "$PANEL/models/qwen3-30b/start" -H "Authorization: Bearer $TOKEN"

until curl -s "$PANEL/runtime/status?model=qwen3-30b" -H "Authorization: Bearer $TOKEN" \
      | jq -e '.running.ready == true' >/dev/null; do
  sleep 3
done
echo "ready"
```

**Only one start/stop operation per model is allowed at a time.** Sending a second one for the same model before the previous one has finished gets 409, with an explanation of what's currently in progress. This is to keep a second start from killing the container the first start is still loading. When a script hits 409, it should wait and retry rather than treat it as a hard failure. Starts and stops for different models can run at the same time.

**Calling start again on a model that's already running rebuilds the container**; it's not a no-op. Check `runtime/status` first to decide whether a start is actually needed.

### Default model

```bash
# Show the default model and the names of running models
curl -s "$PANEL/runtime/default-model" -H "Authorization: Bearer $TOKEN"

# Change the default model
curl -s -X PUT "$PANEL/runtime/default-model" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"model":"qwen3-8b"}'
```

The `GET` response is `{ "defaultModel", "kind", "degraded", "models" }`: `defaultModel` is the effective default; `kind` is `managed` (a managed model), `external` (an external upstream) or `null` (no default); `degraded: true` means the default external upstream is unreachable and requests without `model` are being temporarily redirected to a managed model; `models` lists the names of running managed models.

The `model` in `PUT` can be the name of a running managed model or of an enabled external upstream. It returns 409 if the model isn't running or the upstream is disabled.

A managed model's default exists only in the panel process; after a panel restart, the earliest-started running model is picked again. An external upstream set as default is saved, survives a restart, and starting a managed model afterwards doesn't change it. Setting a managed model as default again clears that setting.

Stopping can be told to wait for the current generation to finish first:

```bash
curl -s -X POST "$PANEL/models/qwen3-30b/stop" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"drain": true, "drainTimeoutMs": 60000}'
```

The response's `drain.reason` explains the actual outcome: `idle` means it waited until idle, `timeout` means it stopped anyway after the wait timed out, `unavailable` means busy status couldn't be probed so it went ahead, and `skipped` means the probe never ran at all (the model's port couldn't be determined, for instance). Neither of the last two means "already idle".

`drainTimeoutMs` accepts 1000–600000 milliseconds (1 second to 10 minutes); anything outside that range returns 400. Without a `drain` field, no waiting happens at all.

### Check VRAM before starting

```bash
curl -s "$PANEL/models/qwen3-30b/preflight" -H "Authorization: Bearer $TOKEN"
```

```json
{ "verdict": "warn", "freeMib": 8192, "totalMib": 24576, "peakNetMib": 19000, "runCount": 3 }
```

`verdict` has three possible values: `ok`, free VRAM is enough; `warn`, might not be enough; `unknown`, not enough basis to judge (no run history, or GPU readings unavailable).

This is **advisory only** and doesn't affect the start endpoint's behavior; the judgment is based on this model's peak VRAM usage across past runs, while actual usage depends on quantization, context length and several other factors, so it can't give a precise prediction.

### Submit a download and track progress

Direct URL download:

```bash
curl -s -X POST "$PANEL/downloads/direct" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com/model.gguf","targetDir":"main"}'
```

Returns 202 and a set of task ids. `targetDir` is a path relative to the model library root; `filename` is optional and is derived from the last segment of the link when omitted.

There are two ways to check progress. Polling:

```bash
curl -s "$PANEL/downloads" -H "Authorization: Bearer $TOKEN"
```

Returns `{ "tasks": [...], "history": [...] }`. Each task's `status` is one of `pending` / `downloading` / `paused` / `completed` / `failed` / `cancelled`; `downloadedBytes` and `expectedSize` are used to compute a percentage.

Or subscribe to the progress stream, which pushes a full snapshot once a second:

```bash
curl -N "$PANEL/downloads/stream" -H "Authorization: Bearer $TOKEN"
```

This stream never ends on its own, and doesn't distinguish event types; each frame's JSON has a `type` field, `tasks` is the task snapshot, and `history` is the history record pushed once when the connection is established. To decide "is the download done," look at the task's `status`; don't wait for the server to close the connection.

Individual tasks can be paused, resumed, cancelled, or retried:

```bash
curl -s -X POST "$PANEL/downloads/12/pause"  -H "Authorization: Bearer $TOKEN"
curl -s -X POST "$PANEL/downloads/12/resume" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "$PANEL/downloads/12/cancel" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "$PANEL/downloads/12/retry"  -H "Authorization: Bearer $TOKEN"
```

Note the difference between `POST /downloads/resume` (resumes the whole queue) and `POST /downloads/<id>/resume` (resumes a single task); the paths look similar but do different things.

### Read monitoring data

Current readings come from three independent sources, fetched separately:

```bash
curl -s "$PANEL/container/stats" -H "Authorization: Bearer $TOKEN"  # Container CPU/memory and inference metrics
curl -s "$PANEL/gpu/stats"       -H "Authorization: Bearer $TOKEN"  # GPU VRAM, utilization, temperature
curl -s "$PANEL/host/stats"      -H "Authorization: Bearer $TOKEN"  # Host CPU, memory, load, disk and network
```

GPU readings still return 200 when there's no GPU or the probe hasn't finished yet; use the `status` field in the response to tell them apart, not the HTTP status code.

History charts use a windowed query:

```bash
curl -s "$PANEL/metrics/window?range=2h" -H "Authorization: Bearer $TOKEN"
```

`range` only accepts `30m` / `2h` / `24h` / `7d`; any other value returns 400. In the response, `series` is an array of data points per metric, and `from` is the window's start as a millisecond timestamp.

For continuous collection, add `since=<the latest timestamp you last got>` to fetch only new points; the response's `mode` will then be `delta`. **An empty array means opposite things in the two modes**: in `full` mode an empty array means this metric has never been collected; in `delta` mode an empty array just means there were no new points this round. Check the `mode` field to tell which; don't guess.

### Subscribe to events and logs

Operational events the panel records (model start/stop, download completion, login, config changes, etc.):

```bash
curl -s "$PANEL/events" -H "Authorization: Bearer $TOKEN"          # Query history
curl -N "$PANEL/events/stream" -H "Authorization: Bearer $TOKEN"   # Real-time subscription

# One event type only, and more of them
curl -s "$PANEL/events?kind=model.start_failed&limit=50" \
  -H "Authorization: Bearer $TOKEN"
```

`limit` defaults to 20 and caps at 100; invalid values silently fall back to the default. `kind` is an exact match, with values like `model.start`, `model.stop`, `model.update`, `model.delete`, `model.start_failed`.

Container logs for the currently running model:

```bash
curl -N "$PANEL/logs/stream" -H "Authorization: Bearer $TOKEN"
```

The two streams behave differently on reconnect: every log line in the log stream is numbered, and reconnecting with a `Last-Event-ID` header replays what was missed during the disconnect (only the most recent batch; too long a gap leaves a gap); the event stream doesn't support replay, and a reconnect instead re-pushes a fresh snapshot to resync.

### Environment doctor

```bash
curl -s "$PANEL/doctor" -H "Authorization: Bearer $TOKEN"
```

Returns Docker connectivity, model library path, disk space, GPU, download source and other check results item by item, each concluding `ok` / `warn` / `fail`. Good to drop into a post-deployment acceptance script. Note that a GPU or download-source check failure is recorded as `warn`, not `fail`; a CPU-only deployment, and not using Hugging Face, are both legitimate setups.

### Back up and restore config

There are two kinds of export, and their behavior is quite different.

**Single model**: returns the YAML content directly as the response, which you can save to a file:

```bash
curl -s -X POST "$PANEL/export?model=qwen3-30b" \
  -H "Authorization: Bearer $TOKEN" -o qwen3-30b.yaml
```

**Full config**: the server packs a zip and writes it to its own disk; the response gives you **the path and size, not the file content**:

```bash
curl -s -X POST "$PANEL/export" -H "Authorization: Bearer $TOKEN"
# {"path":"/app/config/export/llamapad-20260902T031405Z.zip","bytes":8421}
```

To fetch that zip, look under `data/export/` in the deployment directory (this directory is mounted to `/app/config/export` inside the container).

If all you want is "a config backup you can roll back to at any time," it's less work to just flip on the auto-snapshot toggle on the Settings page; every config change writes the full config to `data/export/latest.yaml`, and checking that directory into git gives you a backup with history.

Restoring uses the import endpoint; the request body is JSON, with the full YAML text in the `content` field:

```bash
curl -s -X POST "$PANEL/import" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "$(jq -Rs '{content: ., format: "llamapad", strategy: "skip"}' backup.yaml)"
```

`strategy` decides how a same-named model is handled: `skip` (default), `rename` on import (adds a suffix), or `overwrite`.

Before importing for real, you can pre-check with `POST /import/preview`, whose request body only needs `content` and `format`. It writes nothing; it just tells you which models would be imported, and whether each model's referenced files already exist on this machine.

The YAML's field structure, and how to migrate from the bash version of llama-launcher, are covered in [Config Format & Migration](./config.md).

### Manage files

```bash
# Directory tree and each file's reference count
curl -s "$PANEL/files/tree" -H "Authorization: Bearer $TOKEN"

# Which models reference a given file
curl -s "$PANEL/files/refs?path=main/model.gguf" -H "Authorization: Bearer $TOKEN"

# Delete (returns 409 if referenced; add force to actually delete)
curl -s -X DELETE "$PANEL/files" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"path":"main/old.gguf"}'
```

Paths in requests are always relative to the model library root, never a host absolute path.

Both delete and move come with a reference check: a file currently referenced by a model config returns 409 and lists which models; if a model referencing it is currently running, it returns 423, and even `force` doesn't let it through in that case; you have to stop the model first. Move and rename automatically rewrite every model config that points at the file, so you don't need to update each one by hand.

Shard groups are handled as a whole: moving or renaming any one shard in the group brings the rest of that group along with it.

### External upstreams

External upstreams are OpenAI-compatible services that the panel doesn't start or stop but that can be reached through the relay endpoint; usage is covered in [Inference Interface](./inference.md). Below are the endpoints for managing them. **No endpoint ever returns a key in plaintext**; `hasApiKey` and `apiKeyTail` (the last 4 characters) stand in for it.

Fields of an upstream object:

| Field | Description |
| --- | --- |
| `name` | Name, and the value to write in a request's `model`; it can't be changed after creation |
| `displayName` | Display name |
| `baseUrl` | Upstream URL, up to but not including `/v1` |
| `hasApiKey` | Whether a key is stored |
| `apiKeyTail` | Last 4 characters of the key; `null` when there's no key |
| `upstreamModel` | Model name substituted into the request when forwarding; `null` if unset |
| `enabled` | Whether it's enabled |
| `note` | Note; `null` if unset |
| `state` | Health state: `unknown` / `reachable` / `unreachable` / `disabled` (a disabled upstream is always `disabled`) |
| `lastCheckedAt` | Time of the last conclusive check (ISO string); `null` if none |
| `lastError` | Reason for the last failed probe; `null` if none |
| `isDefault` | Whether this upstream has been set as the default |
| `aliases` | Array of aliases in registration order, each `{ alias, upstreamModel }`, with `upstreamModel` `null` when unset; an empty array when there are none |
| `createdAt` / `updatedAt` | Creation and last-modified time (ISO strings) |

```bash
# List, sorted by name
curl -s "$PANEL/upstreams" -H "Authorization: Bearer $TOKEN"

# Register
curl -s -X POST "$PANEL/upstreams" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"strata","displayName":"Strata","baseUrl":"http://192.168.1.10:8080","apiKey":"sk-xxxx"}'
```

`GET /upstreams` returns `{ "upstreams": [ … ] }`. The request body of `POST /upstreams`: `name`, `displayName` and `baseUrl` are required; `apiKey`, `upstreamModel` and `note` are optional (and may be `null`); `enabled` is optional (enabled by default); `aliases` is optional (omitted means no aliases). Success returns 201 with the upstream object, and the panel probes it once right away.

- Validation failures return 400, with `issues` pointing at the field via `path`: `name` that breaks the naming rule or is reserved (`test`, `probe`), a `baseUrl` that isn't an `http` / `https` address, an `apiKey` containing whitespace, line breaks or non-ASCII characters.
- A name that collides with an existing upstream or model config returns 409.
- Each element of `aliases` looks like `{ "alias": "gpt-4.1", "upstreamModel": "qwen-real" }`; `alias` must be a string, and `upstreamModel` may be omitted or `null`. Surrounding whitespace is stripped from `upstreamModel` and an empty string counts as unset; `alias` itself is not trimmed. An invalid alias (bad format, too long, duplicate, equal to the owning upstream's name, more than 50) also returns 400, with `path` pointing at the problem: `aliases.0.alias`, `aliases.0.upstreamModel`, or `aliases` when there are too many.
- An alias equal to the name of a model config, the name of an upstream, or another upstream's alias returns 409, with `path` `aliases.<index>.alias`; creating an upstream whose name equals an existing alias is also 409.
- A trailing `/v1`, trailing slashes, a query string and a username/password in the URL are stripped on save; the `baseUrl` in the response is the stripped result.

```bash
# One upstream; 404 if it doesn't exist
curl -s "$PANEL/upstreams/strata" -H "Authorization: Bearer $TOKEN"

# Update: every field is optional, omitted fields stay unchanged
curl -s -X PUT "$PANEL/upstreams/strata" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"enabled":false}'

# Delete; success returns 204 with no body
curl -s -X DELETE "$PANEL/upstreams/strata" -H "Authorization: Bearer $TOKEN"
```

`PUT /upstreams/{name}` accepts `displayName`, `baseUrl`, `apiKey`, `upstreamModel`, `enabled`, `note` and `aliases`, all optional; an `apiKey` of an empty string or `null` clears the key; `name` can't be changed (including it in the body is rejected as an invalid field with 400). Omitting `aliases` leaves them unchanged; giving it replaces the whole list, and an empty array `[]` clears all aliases. The alias change and the other field changes take effect together: if validation or a conflict fails, nothing is changed. Validation rules are the same as for creation, and a missing upstream returns 404. The panel probes the upstream again after an update.

If the upstream removed by `DELETE /upstreams/{name}` is the default one, the default setting is cleared with it and falls back to the "earliest-started managed model" rule.

There are two connection-test endpoints with the same response shape:

```bash
# Probe a registered upstream
curl -s -X POST "$PANEL/upstreams/strata/test" -H "Authorization: Bearer $TOKEN"

# Test before saving: probes with the URL and key from the body, nothing is stored and no upstream's health state is affected
curl -s -X POST "$PANEL/upstreams/test" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"baseUrl":"http://192.168.1.10:8080","apiKey":"sk-xxxx"}'
```

```json
{
  "ok": true,
  "status": 200,
  "latencyMs": 38,
  "models": ["Qwen3-32B"],
  "error": null
}
```

`ok` means an HTTP response came back, i.e. the service is online, not that authentication passed: `status` is the status code the upstream returned, and 401 usually means a wrong key. `models` lists the model names from the upstream's `/v1/models`, and `error` is the reason when it couldn't connect. The body of `POST /upstreams/test` is `{ baseUrl, apiKey?, name? }`: when editing an existing upstream the stored key isn't available in plaintext, so leave `apiKey` out and give `name` to use that upstream's stored key; an invalid `baseUrl` or an `apiKey` with illegal characters returns 400. Testing a registered upstream returns 404 if it doesn't exist.

`POST /upstreams/probe` triggers one background probe for every enabled upstream (repeats within 15 seconds don't probe again) and returns 202 immediately without waiting; read the results from `GET /upstreams` a moment later.

### Data behind the API Relay page

`GET /relay/overview` returns what the "API Relay" page shows:

```json
{
  "defaultModel": "strata",
  "defaultTarget": { "name": "strata", "kind": "external", "degraded": false },
  "defaultUpstream": "strata",
  "services": [
    {
      "model": "qwen3-30b",
      "isDefault": false,
      "upstreamBase": "http://…:18080",
      "params": { "image": "…", "gpu": "…", "ctxSize": 32768 }
    }
  ]
}
```

- `defaultModel` is the effective default target name, which may be an external upstream.
- `defaultTarget` describes its kind: `kind` is `managed`, `external` or `null` (no default); `degraded: true` means the default upstream is unreachable and requests without `model` are being temporarily redirected to a managed model.
- `defaultUpstream` is the name of the upstream set as default and still enabled, or `null`.
- `services` are the running managed models; each item has, on top of the fields of `models[]` in `GET /runtime/status`, `isDefault`, `upstreamBase` (the address the panel uses to reach the model) and `params` (key effective settings such as image, GPU and context length). Only a few of those fields are shown here.

## Things to watch for

**A write's side effects aren't always obvious from the path alone.** Operations like editing a model config, a namespace, or an import also update the config snapshot file; moving a file rewrites the model configs that reference it. It's worth exporting a backup before doing anything in bulk.

**Some operations aren't all-or-nothing.** A bulk delete stops when it hits an invalid path; files already deleted before that point stay deleted, and the response doesn't list which ones were removed. If a file move finishes moving the file but then fails to rewrite the config, it returns 500 with a notice that the config wasn't updated; in this case the file is at its new location while the config still points at the old path, and needs manual reconciliation.

**Async endpoints don't hand you the result directly.** The endpoint that computes a file's full hash returns 202 immediately and finishes there; the actual computation runs in the background, and you need to query the file's metadata again, or watch the event stream, to see the result. By contrast, the "auto-locate" endpoint is synchronous; it has to scan the whole model library comparing hashes, which gets noticeably slow with a lot of files, so don't set too short a timeout for it.

**Image pulls use SSE, not a regular response.** The HTTP status code is always 200; success and failure both show up in the stream's `type` field (`progress` / `done` / `error`); don't judge the outcome by the status code.

**Clearing a credential means sending `null`, not an empty string.** On settings endpoints, an empty string is rejected as an invalid value.

## Full endpoint reference

All paths below omit the `/api/v1` prefix.

### Authentication & account

| Method & path | Description |
| --- | --- |
| `POST /auth/login` | Log in with the admin password, issuing a session cookie |
| `POST /auth/logout` | Log out of the current session |
| `GET /auth/me` | Current login status |
| `POST /auth/setup` | First-time admin setup; returns 403 once already set up |
| `GET /auth/tokens` | List of API tokens (last 4 characters shown only) |
| `POST /auth/tokens` | Issue a new token; the plaintext is returned this one time only |
| `DELETE /auth/tokens/{id}` | Revoke a token |

These three token endpoints only accept a session cookie, not token authentication (see the Authentication section above). The admin password isn't changed through the API; see [Settings](./settings.md).

### Models & runtime

| Method & path | Description |
| --- | --- |
| `GET /models` | Model list, with run state and file state |
| `POST /models` | Create a model config |
| `GET /models/{name}` | A single model's config |
| `PUT /models/{name}` | Update a model config; saving is allowed while the model runs, but the container isn't hot-updated; a restart is needed |
| `DELETE /models/{name}` | Delete a model config, without deleting disk files |
| `GET /models/{name}/effective` | Effective parameters: the result of merging the default config with this model's overrides |
| `GET /models/{name}/preflight` | VRAM hint before starting |
| `POST /models/{name}/start` | Start |
| `POST /models/{name}/stop` | Stop |
| `POST /models/{name}/restart` | Restart |
| `POST /models/{name}/move` | Change namespace, without moving files |
| `POST /models/{name}/move-files` | Move model files, without changing namespace |
| `GET /namespaces` | Namespace list with each one's usage |
| `POST /namespaces` | Create a namespace |
| `PATCH /namespaces/{name}` | Rename a namespace |
| `DELETE /namespaces/{name}` | Delete a namespace, must be emptied first |
| `GET /runtime/status` | Run state, can take `?model=` and `?busy=1` |
| `GET /runtime/default-model` | Default model and names of running models |
| `PUT /runtime/default-model` | Change the default model; accepts a running managed model or an enabled external upstream |
| `GET /runs` | Run history, can take `?limit=` |

`move` and `move-files` are two different things: the former only changes the grouping label, the latter only moves files; don't mix them up.

### Downloads & repo profiles

| Method & path | Description |
| --- | --- |
| `GET /downloads` | Current tasks and recent history |
| `POST /downloads/direct` | Submit a direct URL download |
| `DELETE /downloads/history` | Clear finished download records (completed / failed / cancelled); doesn't affect in-progress tasks or files on disk |
| `POST /downloads/resume` | Resume the whole download queue |
| `GET /downloads/stream` | Progress stream (SSE, one full snapshot per second) |
| `POST /downloads/{id}/pause` | Pause a single task |
| `POST /downloads/{id}/resume` | Resume a single task |
| `POST /downloads/{id}/cancel` | Cancel a single task |
| `POST /downloads/{id}/retry` | Retry a failed task |
| `GET /repos` | Repo profile list |
| `POST /repos` | Register a repo profile |
| `POST /repos/probe` | Probe a repo's contents, without registering it |
| `DELETE /repos/{id}` | Delete a profile, optionally deleting its files too |
| `GET /repos/{id}/files` | Quantization groups in a profile and their local status; the remote quant list is cached for 24 hours, `?refresh=1` bypasses the cache and force-refetches, see [Files & Namespaces](./files.md) |
| `POST /repos/{id}/download` | Submit a download for a quantization group |
| `POST /repos/{id}/move` | Change where a profile is stored |
| `POST /repos/{id}/repair` | Recreate a profile's directory |
| `GET /repos/{id}/readme` | A profile's HF model card: body text, license and other badges, and extracted recommended parameters; `?refresh=1` bypasses the cache and force-refetches |
| `GET /hf/repos/{id}/files` | Read a Hugging Face repo's file listing directly |

### Param presets

| Method & path | Description |
| --- | --- |
| `GET /presets` | All param presets, sorted by name; the three built-in ones aren't in this route; the frontend prepends them to the list itself |
| `POST /presets` | Create a preset |
| `PATCH /presets/{id}` | Rename / edit description / change parameters; all three fields are optional |
| `DELETE /presets/{id}` | Delete a preset; applying a preset is a snapshot, so deleting one doesn't affect model configs it was already applied to |

### Files & directories

| Method & path | Description |
| --- | --- |
| `GET /files/tree` | Model library directory tree, with each file's reference count |
| `GET /files/refs` | Query which models reference a given file |
| `DELETE /files` | Delete a file, wildcards supported for a whole group |
| `POST /files/bulk-delete` | Bulk delete; a single item's failure doesn't stop the rest |
| `POST /files/move` | Move a file into an existing directory |
| `POST /files/rename` | Rename a file |
| `GET /folders` | Directory list |
| `POST /folders` | Create a directory |
| `POST /folders/rename` | Rename a directory |
| `GET /disk` | Disk usage summary |
| `GET /file-meta` | File metadata list (quantization label, notes, hash) |
| `PUT /file-meta` | Edit a quantization label and notes |
| `POST /file-meta/checksum` | Compute a file's full hash in the background |
| `POST /file-meta/locate` | Find candidate physical files for a metadata record |
| `POST /file-meta/relink` | Confirm relinking to a candidate file |
| `DELETE /file-meta/orphans` | Clean up metadata records whose physical file no longer exists |

### Monitoring, events & diagnostics

| Method & path | Description |
| --- | --- |
| `GET /container/stats` | Current readings for container CPU, memory and inference metrics |
| `GET /gpu/stats` | VRAM, utilization, temperature |
| `GET /host/stats` | Host CPU, memory, 1-minute load, disk free and read/write IO, network throughput |
| `GET /metrics/window` | History chart, `range` takes `30m`/`2h`/`24h`/`7d` |
| `GET /events` | Operational event history; supports `?limit=` (default 20, max 100) and `?kind=` (exact event-type match) |
| `GET /events/stream` | Real-time event subscription (SSE) |
| `GET /logs/stream` | Container logs for the currently running model (SSE) |
| `GET /doctor` | Environment doctor |

### Settings & config

| Method & path | Description |
| --- | --- |
| `GET /settings/{key}` | Read a settings item |
| `PUT /settings/{key}` | Write a settings item; writable keys are `default_config`, `auto_snapshot`, `onboarding_playground_seen` |
| `GET /settings/hf` | Download source and outbound proxy config (credentials show only the last 4 characters) |
| `PUT /settings/hf` | Change the download source and proxy, taking effect immediately |
| `POST /settings/hf/test` | Make a real request to Hugging Face using the current config to verify connectivity |
| `GET /settings/host-net` | Network monitoring interface setting |
| `PUT /settings/host-net` | Switch the monitoring interface |
| `GET /settings/locale` | Current UI language |
| `POST /settings/locale` | Switch the UI language |
| `GET /settings/webhooks` | Webhook channel config |
| `PUT /settings/webhooks` | Replace the entire channel config at once |
| `POST /settings/webhooks/test` | Send a test push to a specified channel |
| `POST /export` | Export config, with `?model=` to export a single model |
| `POST /import` | Import config |
| `POST /import/preview` | Import pre-check, without writing |
| `POST /migrate/bash` | Batch-migrate from the bash version of llama-launcher |
| `GET /images` | Available and already-pulled llama.cpp images |
| `POST /images/pull` | Pull an image (SSE returns progress) |
| `DELETE /images` | Delete a local image; the currently effective image can't be deleted |

### External upstreams & the API Relay page

| Method & path | Description |
| --- | --- |
| `GET /upstreams` | List external upstreams; keys show only the last 4 characters |
| `POST /upstreams` | Register an external upstream; returns 201 on success |
| `GET /upstreams/{name}` | One external upstream |
| `PUT /upstreams/{name}` | Update an external upstream; all fields optional (including `aliases`, which replaces the whole list); an `apiKey` of an empty string or `null` clears the key |
| `DELETE /upstreams/{name}` | Delete; returns 204 on success; deleting the default upstream clears the default too |
| `POST /upstreams/{name}/test` | Probe a registered upstream |
| `POST /upstreams/test` | Test before saving: probes with the URL and key from the body, nothing is stored |
| `POST /upstreams/probe` | Trigger a background probe of every enabled upstream; returns 202 without waiting |
| `GET /relay/overview` | Data for the API Relay page: the default target and the running managed services |

### Inference relay

| Method & path | Description |
| --- | --- |
| `/proxy/llama/*` | Forwards to the currently running model's inference API, see [Inference Interface](./inference.md) |

This prefix also has a short alias, `/llama-proxy/*` (without the `/api/v1` prefix); both behave identically, so use whichever form you like when connecting a client.
