# Panel API

Every action in the panel's UI is backed by an HTTP request, and these same endpoints can be called directly from a script. That makes them a good fit for scheduled backups, wiring model start/stop into your own ops workflow, or feeding download tasks and monitoring data into another system.

Inference requests go through a separate entry point — see [Inference Interface](./inference.md).

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

- **Four account-security endpoints don't accept token authentication.** The three in the `/auth/tokens` group (list / issue / revoke) plus `PUT /auth/password` only recognize a browser's logged-in session — calling them with `lp_…` gets 401. This way, even if a token leaks, whoever has it can't use it to issue new tokens, revoke someone else's, or change the admin password.
- **The browser's `EventSource` can't send a Bearer header.** Its API doesn't support custom request headers, so it can only rely on a same-origin page's login state. To subscribe to SSE from a script, use an HTTP client that supports custom headers (`curl -N`, `fetch` with `ReadableStream`, Python's `httpx`, etc.).

Revoking a token takes effect immediately — the next request from a program still using it gets 401. Changing the password does not revoke already-issued tokens.

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
    "container": "llamapad-llama",
    "startedAt": "2026-09-02T01:20:00.000Z",
    "hostPort": 18080,
    "configStale": false,
    "ready": true
  }
}
```

`running` is `null` when no model is running.

Two fields determine how you should write your script:

- **`ready`** tells you whether llama-server is actually able to accept requests yet. There's a window between the container coming up and it truly being ready — on a large model this can be tens of seconds — during which `ready` is `false`. Scripts checking "is the model usable yet" should look at this field, not just at whether `running` is non-null.
- **`configStale`** being `true` means this model's config was changed after it started, so it's currently running with the old parameters — a restart is needed for the new ones to take effect.

Adding `?busy=1` returns an extra `busy` field, telling you whether it's currently generating content and how many slots are occupied. This requires an extra probe request to the model server, meant for scenarios like "restart once it's idle" — don't put it in a high-frequency poll.

`busy` being `null` means **couldn't be determined**, not idle — this is the value both when no model is running and when the probe request itself fails. Don't treat it as a green light in "wait until idle" logic.

### Start, stop and switch models

```bash
# Start (or switch over from a different model — the panel only ever runs one at a time, and stops the old one automatically)
curl -s -X POST "$PANEL/models/qwen3-30b/start" -H "Authorization: Bearer $TOKEN"

# Stop
curl -s -X POST "$PANEL/models/qwen3-30b/stop" -H "Authorization: Bearer $TOKEN"

# Restart (to apply new parameters after a config change)
curl -s -X POST "$PANEL/models/qwen3-30b/restart" -H "Authorization: Bearer $TOKEN"
```

A successful start returns `{"id": "<container id>"}`; stop returns `{"ok": true}`.

Three things are easy to get wrong when scripting against this:

**A 200 response doesn't mean the model is usable yet.** The endpoint returns as soon as Docker has been told to start the container — the weights are still loading. To wait for it to actually be usable, poll `runtime/status` until `ready` is `true`:

```bash
curl -s -X POST "$PANEL/models/qwen3-30b/start" -H "Authorization: Bearer $TOKEN"

until curl -s "$PANEL/runtime/status" -H "Authorization: Bearer $TOKEN" \
      | grep -q '"ready":true'; do
  sleep 3
done
echo "ready"
```

**Only one start/stop operation is allowed at a time.** Sending a second one before the previous one has finished gets 409, with an explanation of what's currently in progress. This is to keep a second start from killing the container the first start is still loading. When a script hits 409, it should wait and retry rather than treat it as a hard failure.

**Calling start again on a model that's already running rebuilds the container** — it's not a no-op. Check `runtime/status` first to decide whether a start is actually needed.

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

`verdict` has three possible values: `ok` — free VRAM is enough, `warn` — might not be enough, `unknown` — not enough basis to judge (no run history, or GPU readings unavailable).

This is **advisory only** and doesn't affect the start endpoint's behavior — the judgment is based on this model's peak VRAM usage across past runs, while actual usage depends on quantization, context length and several other factors, so it can't give a precise prediction.

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

This stream never ends on its own, and doesn't distinguish event types — each frame's JSON has a `type` field, `tasks` is the task snapshot, and `history` is the history record pushed once when the connection is established. To decide "is the download done," look at the task's `status` — don't wait for the server to close the connection.

Individual tasks can be paused, resumed, cancelled, or retried:

```bash
curl -s -X POST "$PANEL/downloads/12/pause"  -H "Authorization: Bearer $TOKEN"
curl -s -X POST "$PANEL/downloads/12/resume" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "$PANEL/downloads/12/cancel" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "$PANEL/downloads/12/retry"  -H "Authorization: Bearer $TOKEN"
```

Note the difference between `POST /downloads/resume` (resumes the whole queue) and `POST /downloads/<id>/resume` (resumes a single task) — the paths look similar but do different things.

### Read monitoring data

Current readings come from three independent sources, fetched separately:

```bash
curl -s "$PANEL/container/stats" -H "Authorization: Bearer $TOKEN"  # Container CPU/memory and inference metrics
curl -s "$PANEL/gpu/stats"       -H "Authorization: Bearer $TOKEN"  # GPU VRAM, utilization, temperature
curl -s "$PANEL/host/stats"      -H "Authorization: Bearer $TOKEN"  # Host CPU, memory, load, disk and network
```

GPU readings still return 200 when there's no GPU or the probe hasn't finished yet — use the `status` field in the response to tell them apart, not the HTTP status code.

History charts use a windowed query:

```bash
curl -s "$PANEL/metrics/window?range=2h" -H "Authorization: Bearer $TOKEN"
```

`range` only accepts `30m` / `2h` / `24h` / `7d`; any other value returns 400. In the response, `series` is an array of data points per metric, and `from` is the window's start as a millisecond timestamp.

For continuous collection, add `since=<the latest timestamp you last got>` to fetch only new points — the response's `mode` will then be `delta`. **An empty array means opposite things in the two modes**: in `full` mode an empty array means this metric has never been collected; in `delta` mode an empty array just means there were no new points this round. Check the `mode` field to tell which — don't guess.

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

The two streams behave differently on reconnect: every log line in the log stream is numbered, and reconnecting with a `Last-Event-ID` header replays what was missed during the disconnect (only the most recent batch — too long a gap leaves a gap); the event stream doesn't support replay, and a reconnect instead re-pushes a fresh snapshot to resync.

### Environment doctor

```bash
curl -s "$PANEL/doctor" -H "Authorization: Bearer $TOKEN"
```

Returns Docker connectivity, model library path, disk space, GPU, download source and other check results item by item, each concluding `ok` / `warn` / `fail`. Good to drop into a post-deployment acceptance script. Note that a GPU or download-source check failure is recorded as `warn`, not `fail` — a CPU-only deployment, and not using Hugging Face, are both legitimate setups.

### Back up and restore config

There are two kinds of export, and their behavior is quite different.

**Single model** — returns the YAML content directly as the response, which you can save to a file:

```bash
curl -s -X POST "$PANEL/export?model=qwen3-30b" \
  -H "Authorization: Bearer $TOKEN" -o qwen3-30b.yaml
```

**Full config** — the server packs a zip and writes it to its own disk; the response gives you **the path and size, not the file content**:

```bash
curl -s -X POST "$PANEL/export" -H "Authorization: Bearer $TOKEN"
# {"path":"/app/config/export/llamapad-20260902T031405Z.zip","bytes":8421}
```

To fetch that zip, look under `data/export/` in the deployment directory (this directory is mounted to `/app/config/export` inside the container).

If all you want is "a config backup you can roll back to at any time," it's less work to just flip on the auto-snapshot toggle on the Settings page — every config change writes the full config to `data/export/latest.yaml`, and checking that directory into git gives you a backup with history.

Restoring uses the import endpoint; the request body is JSON, with the full YAML text in the `content` field:

```bash
curl -s -X POST "$PANEL/import" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "$(jq -Rs '{content: ., format: "llamapad", strategy: "skip"}' backup.yaml)"
```

`strategy` decides how a same-named model is handled: `skip` (default), `rename` on import (adds a suffix), or `overwrite`.

Before importing for real, you can pre-check with `POST /import/preview`, whose request body only needs `content` and `format`. It writes nothing — it just tells you which models would be imported, and whether each model's referenced files already exist on this machine.

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

Both delete and move come with a reference check: a file currently referenced by a model config returns 409 and lists which models; if a model referencing it is currently running, it returns 423, and even `force` doesn't let it through in that case — you have to stop the model first. Move and rename automatically rewrite every model config that points at the file, so you don't need to update each one by hand.

Shard groups are handled as a whole — moving or renaming any one shard in the group brings the rest of that group along with it.

## Things to watch for

**A write's side effects aren't always obvious from the path alone.** Operations like editing a model config, a namespace, or an import also update the config snapshot file; moving a file rewrites the model configs that reference it. It's worth exporting a backup before doing anything in bulk.

**Some operations aren't all-or-nothing.** A bulk delete stops when it hits an invalid path — files already deleted before that point stay deleted, and the response doesn't list which ones were removed. If a file move finishes moving the file but then fails to rewrite the config, it returns 500 with a notice that the config wasn't updated — in this case the file is at its new location while the config still points at the old path, and needs manual reconciliation.

**Async endpoints don't hand you the result directly.** The endpoint that computes a file's full hash returns 202 immediately and finishes there; the actual computation runs in the background, and you need to query the file's metadata again, or watch the event stream, to see the result. By contrast, the "auto-locate" endpoint is synchronous — it has to scan the whole model library comparing hashes, which gets noticeably slow with a lot of files, so don't set too short a timeout for it.

**Image pulls use SSE, not a regular response.** The HTTP status code is always 200; success and failure both show up in the stream's `type` field (`progress` / `done` / `error`) — don't judge the outcome by the status code.

**Clearing a credential means sending `null`, not an empty string.** On settings endpoints, an empty string is rejected as an invalid value.

## Full endpoint reference

All paths below omit the `/api/v1` prefix.

### Authentication & account

| Method & path | Description |
| --- | --- |
| `POST /auth/login` | Log in with the admin password, issuing a session cookie |
| `POST /auth/logout` | Log out of the current session |
| `GET /auth/me` | Current login status |
| `PUT /auth/password` | Change the admin password (requires verifying the old one) |
| `POST /auth/setup` | First-time admin setup; returns 403 once already set up |
| `GET /auth/tokens` | List of API tokens (last 4 characters shown only) |
| `POST /auth/tokens` | Issue a new token; the plaintext is returned this one time only |
| `DELETE /auth/tokens/{id}` | Revoke a token |

These four endpoints only accept a session cookie, not token authentication (`PUT /auth/password` belongs to the same group — see the Authentication section above).

### Models & runtime

| Method & path | Description |
| --- | --- |
| `GET /models` | Model list, with run state and file state |
| `POST /models` | Create a model config |
| `GET /models/{name}` | A single model's config |
| `PUT /models/{name}` | Update a model config; saving is allowed while the model runs, but the container isn't hot-updated — a restart is needed |
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
| `GET /runtime/status` | Current run state, can take `?busy=1` |
| `GET /runs` | Run history, can take `?limit=` |

`move` and `move-files` are two different things: the former only changes the grouping label, the latter only moves files — don't mix them up.

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
| `GET /repos/{id}/files` | Quantization groups in a profile and their local status |
| `POST /repos/{id}/download` | Submit a download for a quantization group |
| `POST /repos/{id}/move` | Change where a profile is stored |
| `POST /repos/{id}/repair` | Recreate a profile's directory |
| `GET /repos/{id}/readme` | A profile's HF model card: body text, license and other badges, and extracted recommended parameters; `?refresh=1` bypasses the cache and force-refetches |
| `GET /hf/repos/{id}/files` | Read a Hugging Face repo's file listing directly |

### Param presets

| Method & path | Description |
| --- | --- |
| `GET /presets` | All param presets, sorted by name; the three built-in ones aren't in this route — the frontend prepends them to the list itself |
| `POST /presets` | Create a preset |
| `PATCH /presets/{id}` | Rename / edit description / change parameters — all three fields are optional |
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

### Inference relay

| Method & path | Description |
| --- | --- |
| `/proxy/llama/*` | Forwards to the currently running model's inference API, see [Inference Interface](./inference.md) |

This prefix also has a short alias, `/llama-proxy/*` (without the `/api/v1` prefix) — both behave identically, so use whichever form you like when connecting a client.
