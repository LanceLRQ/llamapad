# Deployment & Operations

> Deployment template and notes for a GPU server. Image: built locally as `llamapad:v0.1.0-rc` (not published to a remote registry).
> The deployment directory is self-contained: `docker-compose.yml` + `data/` (panel data) + `models/` (GGUF library) sit side by side — copy the whole thing to move to another machine.

```bash
# Build the image from the repo root (first time, or after a code update)
docker build -t llamapad:v0.1.0-rc .
# Networks with restricted external access (e.g. mainland China servers) must pass proxy args — see "Build proxy" below
```

## Directory layout

The deployment directory is self-contained: all three items sit at the same level, compose mounts everything with relative paths, and the whole directory runs as-is on another machine.

| Path (relative to `docker-compose.yml`) | In container | Purpose |
|---|---|---|
| `.env` | — | Machine-local parameters: initial password, PUID/PGID, optional PANEL_PORT (not checked into git) |
| `data/` | `/app/config` | Panel data volume: `panel.db` (model configs and accounts — this is what backups mainly cover), `export/` (automatic YAML snapshots, can be backed up via git), `logs/` (log files), and an optional `panel.yaml` |
| `models/` | `/host-models` | GGUF model root (newly downloaded models land here too) |

> **You don't need to configure the host's absolute path to `models`**: llama.cpp sibling containers need a host-viewpoint path when they bind-mount, and the panel automatically discovers the host path behind `./models` by querying its own container's mount table via `docker.sock`. Priority order is
> `PANEL_MODELS_HOST` env var > `panel.yaml`'s `paths.models.host` > auto-discovery.
>
> That makes `panel.yaml` **optional**: if the file doesn't exist, everything falls back to its default (models path inside the container is `/host-models`).
> The only scenario where you still need it is for three optional fields — `proxy` (the panel's outbound proxy), `chat.base_url`, and `listen`.

## First-time deployment

```bash
# 1. Create a deployment directory (this example uses /srv/llamapad — swap in your own path), and put the compose file there
mkdir -p /srv/llamapad/data
cd /srv/llamapad
cp /path/to/repo/deploy/docker-compose.yml .

# 2. Model library: symlink an existing directory, or create a fresh one (newly downloaded models land here too)
ln -s /your/existing/gguf/library models   # or: mkdir -p models

# 3. Determine the panel's runtime identity (see "Runtime identity and directory permissions" below)
stat -c '%u:%g' models/   # model library owner, e.g. 0:0

# 4. Initial password and runtime identity (.env is not checked into git)
cat > .env <<'ENV'
PANEL_ADMIN_PASSWORD=<your admin password>
PUID=0
PGID=0
ENV

# 5. Align the data/ directory's owner with PUID/PGID, or SQLite can't open its file (SQLITE_CANTOPEN)
chown -R 0:0 data

# 6. Check that docker.sock's gid matches group_add in the compose file
stat -c %g /var/run/docker.sock   # 984 on this machine; this varies per machine, adjust compose accordingly

# 7. Start the containers
docker compose up -d

# 8. Open http://<server-address>:28960 in a browser -> sign in with PANEL_ADMIN_PASSWORD
#    (the port can be overridden with PANEL_PORT in .env; it's fixed at 28960 inside the container)
```

> **The header's "Open llama UI" link**: leave `chat.base_url` empty when accessing directly over the LAN (`http://IP:28960`) —
> the panel derives `http://<hostname>:<host_port>` from the browser's address automatically. The Chat page itself doesn't
> depend on this field — it goes through the panel's own same-origin reverse proxy, so a single domain over HTTPS works fine
> without it; this field only affects the header's new-tab link to llama.cpp's own bundled web UI, and you only need to set
> it explicitly in `data/panel.yaml` when that button's target domain has HSTS enabled and the browser force-upgrades the
> plain address to https, breaking the connection. See [HTTPS Reverse Proxy](./nginx.md) for an example config.

## Notes

- **`PANEL_DOCKER=real` must be set explicitly** (the default `mock` is for Mac-based development)
- **`PANEL_LLAMA_HOST=host.docker.internal`** (plus `extra_hosts` host-gateway): inside the panel container, `127.0.0.1` doesn't reach ports the sibling container publishes on the host — both the reverse proxy and inference metrics collection go through this address to reach llama-server
- **`gpus: all`**: `nvidia-smi` inside the panel container depends on it; without it, GPU monitoring automatically degrades and hides itself
- The panel runs as non-root by default (`node`, uid 1000); it gets read access to `docker.sock` through `group_add`
- GPU parameters for the llama.cpp container (a sibling container the panel creates) are passed in by the panel based on the model's config


## Runtime identity and directory permissions

The panel needs to write to two bind-mounted directories: `data/` (SQLite and YAML snapshots) and `models/` (downloaded GGUF files). **The user the container runs as must have write access to both**, or you'll see login failures with a 500 (`SQLITE_CANTOPEN`) or download failures (`EACCES: permission denied, mkdir`).

The compose file's `user: "${PUID:-1000}:${PGID:-1000}"` determines the runtime identity, configured in `.env`:

| Scenario | Config |
|---|---|
| Model library is owned by root (common on machines where models were downloaded manually as root) | `PUID=0` `PGID=0`, and `chown -R 0:0 data` |
| Model library is owned by a regular user (e.g. 1000) | Leave PUID/PGID unset (defaults to 1000), and `chown -R 1000:1000 data` |
| Model library is owned by some other uid (e.g. 1002) | `PUID=1002` `PGID=1002`, and `chown -R 1002:1002 data` |

Check the owner with: `stat -c '%u:%g' <models directory>`.

Pick a PUID that matches the existing owner, rather than `chown`-ing the model library the other way around — model libraries often run to hundreds of GB, and re-owning them is slow and can break other things that use them. `data/` is the panel's own data volume, so re-owning it to match PUID has no downside.

`group_add` is unrelated to `user` and is always needed (the panel manages sibling containers through `docker.sock`); when running as root (PUID=0), the socket is already readable, so this setting is harmless.

### The security trade-off of PUID=0 (running as root)

The image defaults to non-root (`USER node`); setting `PUID=0` makes the container run as root, which looks like a downgrade. The real trade-off has to be considered together with mounting `docker.sock`:

**Mounting `docker.sock` is already equivalent to host root privileges** — anyone who can reach the socket can create privileged containers and mount arbitrary host paths. That's an inherent premise of a Portainer-style panel, and a necessary condition for this project to manage sibling containers. Against that backdrop, the incremental risk from the in-container process being uid 0 versus 1000 is limited.

That said, the recommended priority order is still:

1. **You control the model library's ownership** → use non-root (PUID matching that owner), and keep the defense in depth
2. **The model library is root-owned and inconvenient to change** → `PUID=0`, accepting the trade-off above
3. **In no case** should you add `privileged: true` or extra `cap_add` — the panel doesn't need them, and this project never requires them

Before exposing the panel to the public internet, put it behind an HTTPS reverse proxy and make sure the login password is strong.
The panel reads `X-Forwarded-Proto` to automatically detect whether it's currently on HTTPS and sets the session cookie's `Secure`
flag accordingly — see [HTTPS Reverse Proxy](./nginx.md) for the reverse proxy config.

## Upgrading

```bash
cd /path/to/repo && git pull                # Pull the latest code
docker build -t llamapad:v0.1.0-rc .        # Remember the proxy args on restricted networks — see "Build proxy" below
cd /srv/llamapad && docker compose up -d    # Panel data and models live in data/ and models/, nothing is lost on upgrade
```

> **Host network metrics require the container to be recreated**: the `/proc:/host/proc:ro` mount in the compose file
> (the rest of the host metrics — CPU/memory/load/disk, etc. — aren't affected and still work without this mount; only
> network throughput depends on it). A mount is a container-level config that `docker compose up -d` applies automatically,
> but `docker compose restart` does not — when upgrading from an older version, first make sure the compose file has this
> line, then run the `docker compose up -d` above (it recreates the container as needed, it's not just a process restart).
> If mounting `/proc` isn't convenient right now, you can skip this line — the panel silently degrades to not showing
> network throughput, while the rest of the host metrics work normally.

## Backups

The YAML snapshot under `data/export/` updates automatically on every config change:

```bash
cd /srv/llamapad/data/export && git init   # then periodically: git add -A && git commit
```

Disaster recovery: clear the admins/database, then use the panel's "Import" feature to load the snapshot zip or individual model YAML files back in.

---

## Build proxy

On networks with restricted external access, `docker build` can stall on `apt-get` (in testing, a direct connection took over
60 seconds to fail to download a 9.7MB `cpp-12` package from deb.debian.org). Passing Docker's **predefined build args** fixes
this without touching the Dockerfile — BuildKit injects them into the `RUN` environment for every build stage:

```bash
docker build \
  --build-arg HTTP_PROXY=http://<proxy-address>:<port> \
  --build-arg HTTPS_PROXY=http://<proxy-address>:<port> \
  --build-arg http_proxy=http://<proxy-address>:<port> \
  --build-arg https_proxy=http://<proxy-address>:<port> \
  --build-arg NO_PROXY=localhost,127.0.0.1 \
  -t llamapad:v0.1.0-rc .
```

The proxy address needs to be **reachable from inside the build container**: the container is on a bridge network, so
`127.0.0.1` points at the container itself — you need to use the host's LAN IP or gateway address. If you're not sure it's
reachable, verify it first:

```bash
docker run --rm node:22-bookworm-slim node -e '
require("http").request({host:"<proxy-address>",port:<port>,path:"http://deb.debian.org/debian/dists/bookworm/Release",
headers:{Host:"deb.debian.org"}},r=>console.log("HTTP",r.statusCode)).end()'
```

**The proxy args aren't an optional performance tweak — pass them on every build.** The proxy address is part of the
dependency-layer cache key: build with a proxy once, then build without one (or with a different address), and both the
`apt-get` and `pnpm install` layer caches are invalidated and rerun from scratch. In testing, the same codebase built in
17 seconds with the proxy, and was still stuck on `apt-get` after 10 minutes without it.
