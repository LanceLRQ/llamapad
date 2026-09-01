# Troubleshooting

## Login returns 500, or the logs show `SQLITE_CANTOPEN`

**Symptom**: opening the panel in a browser and signing in returns a 500 immediately, and the container logs show `SQLITE_CANTOPEN`.

**Cause**: the panel container runs as the identity specified by `PUID`/`PGID` in `.env`; if that identity doesn't have write access to the host's `data/` directory, SQLite can't even open its own database file. This is most common when the model library is owned by `root` and `.env` hasn't been set to match with `PUID=0`/`PGID=0`.

**Fix**: run `stat -c '%u:%g' data/` to check the actual owner of the `data/` directory, and align `.env`'s `PUID`/`PGID` to match it — or, the other way around, `chown` to align with `.env` (`data/` is the panel's own data volume, so re-owning it has no downside). For the full permission setup, see [Deployment & Operations](./deployment.md).

## Download fails with `EACCES: permission denied, mkdir`

**Symptom**: a newly created download task fails quickly, with `mkdir` and `EACCES` in the error message.

**Cause**: same root cause as above — the panel's runtime identity doesn't have write access to the host's `models/` directory, so the downloader can't create its target subdirectory. The model library is commonly a directory created by hand as `root`, while the panel runs as non-root (`node`, uid 1000) by default.

**Fix**: likewise, run `stat -c '%u:%g' models/` to check the owner, and adjust `.env`'s `PUID`/`PGID` to match it — don't `chown` the entire model library the other way around, since it can easily be hundreds of GB and the cost of that far outweighs changing an environment variable. See the "Runtime identity and directory permissions" section of [Deployment & Operations](./deployment.md) for details.

## Relay endpoint returns 502 "container port not ready"

**Symptom**: calling `/api/v1/proxy/llama/*` (or sending a message in the Playground) returns a 502 with `{"error":"容器端口未就绪"}`.

**Cause**: the model's container has started, but the llama-server process hasn't started listening on its port yet — a large model's cold start (loading weights, allocating VRAM) can take tens of seconds, and there's a window between the panel deciding "the container is up" and llama-server actually being able to accept requests.

**Fix**: wait a few seconds and retry — this is a normal part of starting up. If it keeps returning 502 for a long time (over a minute or two), check the container logs on the [Logs page](./monitoring.md) to confirm whether llama-server is stuck loading, or whether a configured parameter exceeds available VRAM and is causing it to fail to start.

## Relay endpoint returns 503 "no model is running"

**Symptom**: calling the relay endpoint returns a 503 with `{"error":"没有运行中的模型","hint":"/models"}`.

**Cause**: no model is currently running — either it was never started, or it has already been stopped. The relay endpoint only forwards to whichever model is currently running, and rejects outright when there's no target to forward to.

**Fix**: go to the models list and start the target model.

## Over HTTP on the LAN, a button doesn't respond, or the whole page errors out

**Symptom**: when accessing the panel over a LAN IP + HTTP (without HTTPS), clicking "Copy" does nothing, or a creation action (like "Add channel" for Webhooks) turns the whole page into an error screen.

**Cause**: both `navigator.clipboard` (the Clipboard API) and `crypto.randomUUID` (random ID generation) are only exposed in a "secure context" (HTTPS or `localhost`) — under plain LAN HTTP, they're either `undefined` or throw as soon as they're called. The panel already has fallbacks for both of these (copy falls back to `execCommand`, random IDs fall back to `getRandomValues`), so most cases shouldn't hit this anymore; if you're running an older image build, you may still run into it.

**Fix**: upgrade to a newer panel image; if you want to fully resolve the secure-context restriction (e.g. so the browser's address bar shows a lock icon and this class of problem stops recurring), put an HTTPS reverse proxy in front — see [HTTPS Reverse Proxy](./nginx.md).

## llama.cpp's bundled web UI returns 400 when chatting

**Symptom**: clicking "Open llama UI" in the header to go to llama.cpp's bundled web UI, then sending a message, returns a 400.

**Cause**: the `dry_penalty_last_n` parameter is stored as `-1` in that web UI's local settings, and newer versions of llama-server validate that this value must be `≥0`. This setting lives in `localStorage` on llama-server's own origin (e.g. `:18080`), which is a different origin from the panel, so the panel can't change it. See the known limitations in [Inference Interface](./inference.md) for details.

**Fix**: in llama.cpp's own bundled web UI settings panel, change this parameter to `0` or higher. This is upstream llama.cpp behavior, not a panel issue.

## Building the image gets stuck on `apt-get`

**Symptom**: `docker build` sits for a long time on the step that installs system dependencies, unable to download even a few-MB package after several minutes.

**Cause**: on a network with restricted external access, connecting directly to Debian's repos is too slow. The build proxy args aren't an optional performance tweak — the Dockerfile writes the proxy value into `ENV`, and that value becomes part of Docker's build cache key; miss passing the proxy once, and both the `apt-get` and dependency-install layer caches get invalidated and rerun from scratch.

**Fix**: pass the proxy address with `--build-arg HTTP_PROXY=...` and similar args (the host's LAN IP, not `127.0.0.1` — inside the build container, `127.0.0.1` points at itself). Full commands and how to verify them are in the "Build proxy" section of [Deployment & Operations](./deployment.md).

## GPU metrics don't show up

**Symptom**: the VRAM and GPU utilization cards on the Overview page don't appear, or a "GPU monitoring unavailable" notice shows up instead.

**Cause**: the panel container needs to be able to call the host's `nvidia-smi` to collect these two metrics, which depends on `gpus: all` in `docker-compose.yml`. Without this line, the panel container simply can't see any GPU device.

**Fix**: confirm `docker-compose.yml` has `gpus: all`, and that the host has the NVIDIA Container Runtime installed, then run `docker compose up -d` to recreate the container (not `restart` — this class of container-level config only takes effect on a recreate). This is expected on a CPU-only deployment and doesn't need fixing.

## Network throughput / disk I/O metrics are missing

**Symptom**: the "Network I/O" or "Disk I/O" cards on the Overview page stay blank for a long time.

**Cause**: both metric groups require the host's `/proc` to be mounted into the container, which corresponds to `/proc:/host/proc:ro` in `docker-compose.yml`. Without this line mounted, both metric groups silently default to empty, without affecting anything else.

**Fix**: confirm this mount line is in the compose file, then run `docker compose up -d` to recreate the container (a mount is a container-level config; `restart` doesn't apply it). See [Monitoring & Logs](./monitoring.md) for details.

## Starting a model returns 409

**Symptom**: clicking "Start" returns a 409.

**Cause**: the previous start/stop request hasn't finished yet — the panel's start/stop/restart operations are mutually exclusive, and only one is allowed to run at a time. A concurrent second request is rejected outright rather than queued: queuing would make it unclear which model ends up running, and retrying once it fails is cheaper.

**Fix**: wait for the current operation to finish and retry — usually a few seconds to tens of seconds, depending on how long the model takes to load.

## Reasoning effort has no effect after being set, or a model's startup is rejected

**Symptom**: a fixed value was configured for "Reasoning effort" on the model edit page, and after saving, the model's startup is rejected (422) — or the value seems to have been sent but nothing changes during inference.

**Cause**: whether a model supports `reasoning_effort` at all, and which values it accepts, depends entirely on its chat template (this can differ between models, and even between different packagings of the same model family). When the template doesn't read this variable, any value you pass neither errors nor takes effect; when the template does read it and validates the range, passing an out-of-range value gets blocked by the panel before startup (returning 422 and explaining which values are allowed), so you don't end up with a container that starts fine but throws an unreadable error only once an inference request hits it.

**Fix**: change it to a value this model's template supports, or switch back to "Follow the template's own default" (`inherit`). The field's location is covered in [Model Configuration](./models.md); per-request reasoning-effort rewriting (as opposed to this model-level fixed config) is covered in [Inference Interface](./inference.md).

## Where to find diagnostic info

When troubleshooting, these entry points give you the most information:

- **Container logs on the Logs page** (`/logs`, Container Logs group): the `llama.cpp` container's live log stream — the specific errors for a model failing to load or a bad parameter are here.
- **Environment doctor** (Settings page → Runtime): six fixed checks, quick to tell whether it's an environment problem (Docker, paths, GPU, disk) or a config problem.
- **The panel's own container logs**: `docker logs llamapad` (container name depends on your actual deployment) — for the panel's own errors, as opposed to a model container's errors.
