# Deployment script llamapad.sh

> See also [Deployment and operations](./deployment.md). This page documents the `deploy/llamapad.sh` single-file script itself: how to install it, what each command/menu item does, how install state is detected, what files live in the install directory, the built-in safety guards, and every overridable environment variable.

## Overview

`llamapad.sh` is a single-file bash script (bash 3.2+), Linux hosts only. When invoked with `sh`, it re-execs itself with `bash` (these first lines are written to be POSIX sh compatible), but only when the script exists as a file (`sh llamapad.sh`); when piped it cannot read itself, so use `| bash` for the one-line install. It exits with an error if no `bash` binary is found.

One-line install:

```bash
curl -fsSL https://raw.githubusercontent.com/LanceLRQ/llamapad/main/deploy/llamapad.sh | bash
```

Under `curl | bash`, the script cannot read its own source file (`$0` is a pipe), so during install it re-downloads a copy of itself by version tag into the install directory (see "Command entry point" and `place_self` under "File guards and safety mechanisms").

**No TTY** (the script needs to open `/dev/tty` for its interactive menu/prompts; a plain pipe run, CI, or some container environments have no usable terminal): running `curl | bash` directly will error out and suggest downloading first, then running:

```bash
curl -fsSLO https://raw.githubusercontent.com/LanceLRQ/llamapad/main/deploy/llamapad.sh
bash llamapad.sh
```

**Interface language**: the `--lang zh|en` flag, or the `LLAMAPAD_LANG` environment variable (anything starting with `zh` is treated as Chinese, everything else as English); resolution order is `--lang` > `LLAMAPAD_LANG` > `LC_ALL` > `LANG`.

**Install directory**: `--dir <dir>`; see the directory-resolution priority under "Install state detection".

## Command entry point

After a successful install, the script writes a two-line launcher to `/usr/local/bin/llamapad` (overridable via `LLAMAPAD_BIN_DIR`), **not a symlink**:

```sh
#!/bin/sh
export LLAMAPAD_HOME=<install dir>
exec <install dir>/llamapad.sh "$@"
```

The install directory is hard-coded into the launcher, so running `llamapad` from any directory always resolves to this deployment, without relying on `readlink -f` to follow links (this also works on minimal/busybox environments).

- **Overwrite confirmation**: if the target already exists and points to a different installation (its content does not reference this install directory's `llamapad.sh` path), the script asks before overwriting; declining skips it, and you then need to run `<install dir>/llamapad.sh` directly.
- **sudo install**: if `/usr/local/bin` is not writable, the script asks whether to use sudo (`install -m 755`, rather than writing then `mv`, so the file actually ends up owned by root).
- **If skipped**: the installation itself still completes; you just need `<install dir>/llamapad.sh <command>` instead of `llamapad <command>` afterwards.

## Commands and menu items

### install (setup wizard)

Running the script (`llamapad.sh` or `llamapad`) with no command triggers install when nothing is installed yet. Preconditions: the platform must be Linux, a TTY must be available, and Docker must be usable (the `docker` command exists, the daemon is reachable, it is not rootless, and the compose v2 plugin is present).

It asks the following, in order, each with a default you can accept by pressing Enter; **nothing is written until you confirm**:

1. **Install directory** (default `/opt/llamapad`): the path cannot contain spaces or colons; a forbidden path (see "File guards") is rejected; a non-empty target directory lists up to 10 entries and asks whether to proceed anyway; a directory that is already installed (has `.llamapad-state`) goes straight to the management menu; a directory that only has a hand-made compose/`.env` (no `.llamapad-state`) goes to the "adoption" flow described below.
2. **Image source**, in this fixed order: (1) the Docker Hub release `lancelrq/llamapad:<script version>` (annotated if already cached locally); (2) any local image whose repository name is `lancelrq/llamapad` or `llamapad` (this group is omitted if Docker is unavailable or none exist); (3) "Build `llamapad:dev` from the current repo" (only shown when the current working directory `$PWD` is the llamapad repo itself; see the repo-detection rule under "build" below).
3. **Model library location**: lists each mount point with its free space, disk type (NVMe/SSD/HDD/mixed/network/unknown), whether it is the system disk, low-space and network-storage warnings, plus a manual path entry; an existing directory is reported with how many `.gguf` files and total size it already has.
4. **Runtime identity (PUID:PGID)**: the menu options depend on context: if the model library already exists you get "match the model library owner" / "current user" / "root" / "custom"; for a newly created model library you get "regular user 1000:1000 (recommended)" / "current user" / "root" / "custom".
5. **GPU**: probes cards via `nvidia-smi -L`; none found means GPU stays off; cards found but Docker has no NVIDIA runtime (`docker info`'s `Runtimes` lacks `nvidia`, and no CDI spec file is found) warns and defaults to off (though you can still force it on).
6. **Port and listen address**: the port must be 1-65535 and currently free (checked via `ss`/`netstat`, falling back to parsing `/proc/net/tcp{,6}` if neither exists); listen address is one of `0.0.0.0`, `127.0.0.1` (recommended behind an HTTPS reverse proxy), or a custom IPv4 address.
7. **Admin password**: leave empty to generate a random 20-character alphanumeric string; a manual password must be at least 8 characters, contain no single quotes, and is confirmed by re-entry.
8. **Timezone**: defaults to detection via `/etc/timezone` → `timedatectl show -p Timezone` → resolving the `/etc/localtime` symlink, falling back to `UTC`; cannot be empty or contain spaces.
9. **External LLM** (optional): used to parse recommended parameters out of model READMEs; asked by default, can be skipped and configured later in panel settings or via `llamapad config`.
10. **Summary page**: lists every choice; selecting an item lets you revisit it, or you can confirm and write, or cancel the install.

On confirmation: if the image source was "build", the local build runs first; all deployment files are then written in one pass (see "Install directory structure"); on success it asks whether to pull the image and start the panel now; either way it prints the access URLs, the generated admin password (shown once, if it was generated), the config file path, and common command hints.

**Adopting an existing hand-made deployment**: if the install directory already has `docker-compose.yml` or `.env` but no `.llamapad-state`, the script enters the adoption flow instead of the fresh wizard. The directory and any existing `docker-compose.yml`/`docker-compose.gpu.yml`/`.env` in it must be readable and writable by the current user, otherwise it errors and suggests `sudo` (it never guesses and changes ownership on its own). The flow parses the model library path, GPU flag, and image name out of the old `docker-compose.yml`/`.env` (distinguishing "already this script's template", "Hub image", and "custom/local-built image"; the last one asks whether to keep the local image or switch to a Docker Hub version), plus runtime identity, port, listen address, timezone, and LLM config; if no usable password exists it asks you to set one; it shows the adoption plan and asks for confirmation; the three old files are backed up to `backups/adopt-<timestamp>/` before the standard write path runs. **`data/` and the model library are never touched.**

### start

Preflight checks (`preflight_start`, assuming `.env` exists):

- Missing `.env` errors out immediately, suggesting a reinstall or `llamapad config`.
- For a non-Hub image (local/built), the image must already exist locally, otherwise it errors and suggests `llamapad build` first.
- `DOCKER_GID` in `.env` is re-probed from the actual `docker.sock` gid and rewritten every time (machine migration or a Docker reinstall can change it).
- Port occupancy is only checked when the panel is not already running (its own port doesn't count as a conflict).
- The model library directory must exist.
- If `data/`'s owner does not match the configured PUID:PGID, it warns and asks whether to fix it now (`chown`).
- If GPU is enabled but there is no NVIDIA runtime, it refuses to start.

Once checks pass, it runs `docker compose up -d`, polls the panel's `/login` endpoint until it returns 200 (60-second timeout by default, tunable via `LLAMAPAD_READY_TIMEOUT`), then prints the access URLs.

### restart

Runs the same preflight checks as start, but with `docker compose up -d --force-recreate`; because compose only recreates containers when the compose file itself changes, and editing `.env` values that are interpolated into it (port, password, etc.) does not trigger a default recreate, so a config change needs `restart` to take effect.

### stop

`docker compose stop` stops the panel container. If any model containers labeled `llamapad.managed=true` (llama.cpp sibling containers the panel created) are still running, it lists their names, warns that stopping the panel does not stop them, and asks whether to stop them too.

### status

Prints: the panel container status ("not created" if it never was), the current image reference, the listen address:port, the running model (read from the `llamapad.model` label on containers labeled `llamapad.managed=true`), GPU info (card name/VRAM usage from `nvidia-smi` if present), and free disk space on the disks holding `data/` and the model library.

### logs

`docker compose logs --tail 200`; add `-f`/`--follow` to keep following. The menu's "Logs" item always shows only the last 200 lines without following; use `llamapad logs -f` on the command line to follow.

### config

A menu that lets you change: port (the panel's own current port, while running, does not count as a conflict), listen address, model library location (**only the path; files are not moved**; existing model configs store paths relative to the library root, so you must move the files yourself after relocating), runtime identity (it tries to `chown` the data directory first; if that fails the new PUID/PGID is not written, avoiding a half-changed state where the config says one thing and the directory owner says another), GPU toggle, timezone, external LLM, and the admin password (changing it logs out every already-logged-in browser; API Tokens are unaffected). Any change prompts, on leaving the menu, whether to recreate the container now (declining tells you to run `llamapad restart` later).

### build

**Repo lookup order**: `--repo <path>` takes priority, then the current working directory `$PWD`, then the `build_repo` recorded in `.llamapad-state` from a previous `build` (only used if it is still a valid repo). A directory counts as the llamapad repo itself (`repo_detect`) when it has both a `Dockerfile` and a `package.json` whose `"name"` field is `"llamapad"`.

**Detection is based on the current directory only, not on where the script file lives**, so either run it from the repo root (e.g. `bash deploy/llamapad.sh build`) or pass `--repo <repo path>` explicitly. If no repo can be found, it errors and tells you to run from the repo root or specify `--repo`.

The image tag is fixed as `llamapad:dev` (independent of the repo name or machine). If `HTTP_PROXY`/`HTTPS_PROXY` are set in the environment (either case, uppercase preferred), they are passed through to `docker build` as `--build-arg`.

Behavior differs depending on whether the target is already installed:

- **Installed** (a valid `.llamapad-state` exists): builds the image, then sets `.env`'s `LLAMAPAD_IMAGE`/`LLAMAPAD_VERSION` to `llamapad`/`dev`, records `image_source=build` and `build_repo` in state, and asks whether to recreate the container now.
- **Not installed**: `llamapad build` still works; it just builds `llamapad:dev` and **writes no configuration**; it then hints that the install wizard will list this local image under "image source" automatically, or that you can point `--dir <install dir>` at an existing installation and run `build` again to switch it over.

The "Build image" item on the main menu **only appears when a repo can be located**, using the same lookup order as above.

### upgrade

**Hub image flow**: every time the menu header is drawn, it performs an at-most-once-per-24-hours network check against Docker Hub for the latest stable version (recorded as `update_checked_at`/`update_latest` in `.llamapad-state`; the lookup times out after 2 seconds and any failure is silently ignored), showing an "update available" hint in the header when a newer version exists. `llamapad upgrade` defaults to that latest stable version as the target, or you can pass `--to <version>` for any specific version (including a downgrade). A downgrade first warns that "database migrations only move forward; the older version may not be able to read your data." Once confirmed:

1. If the target script version differs from the current one, a **self-update** runs first (two stages: download the new script, `bash -n` syntax check, an exact match against the line `LLAMAPAD_SCRIPT_VERSION="<target>"` to confirm the content is correct, back up the old script to `backups/llamapad.sh.<timestamp>` and replace it, then `exec` into the new script for stage two); if the self-update fails, it asks whether to "upgrade only the image and keep the current script version."
2. Template sync (see the template-consistency section under "File guards").
3. `docker compose pull` for the new image; **a pull failure rolls back**: restoring the version (and image name, if changed this run) in `.env`, undoing the template sync, and telling you to configure `registry-mirrors` or a proxy for Docker on restricted networks.
4. On a successful pull, `docker compose up -d --force-recreate` runs; if that step fails it does **not** roll back the image name or version (the image is already new; only the recreate failed), and instead tells you to troubleshoot and run `llamapad start` manually.

**Local image flow**: when the current image is not a Docker Hub image, `upgrade` instead asks a menu: "rebuild from the repo and recreate the container" (equivalent to `build`; only shown when a repo can be located), "switch to a Docker Hub release", or "cancel". Switching to Hub follows the same upgrade flow above, except the image name is rewritten too; nothing in `.env` changes before you confirm the upgrade, and a failure rolls back both the image name and version following the same rules as above.

`--to` is also useful on restricted networks to skip the latest-version network lookup.

### doctor

Runs a series of checks, each printed as `✔` (ok, does not count as a failure), `⚠` (warn, does not count as a failure), or `✘` (fail, counted):

| Check | ✔ ok | ⚠ warn | ✘ fail |
|---|---|---|---|
| Host platform | Linux | — | not Linux |
| Docker availability | command found, daemon reachable, not rootless, compose v2 present | needs sudo to reach docker.sock | docker missing / daemon unreachable / rootless / compose v2 missing |
| Image readiness | local image already present | Hub image not pulled yet (will pull on first start) | non-Hub local/built image missing locally (suggests `llamapad build`) |
| `.env` required keys | `LLAMAPAD_VERSION`/`PANEL_ADMIN_PASSWORD`/`DOCKER_GID` all set | — | any missing |
| `DOCKER_GID` | matches the actual `docker.sock` gid | — | (mismatch is a warn: `start` fixes it automatically, not counted as a failure) |
| GPU | disabled with no card / enabled with a working runtime | a card is present but GPU is disabled (no VRAM monitoring) | enabled but the NVIDIA runtime is missing |
| Port | held by the running panel / free | — | not running but the port is held by something else |
| `data/` owner | matches PUID:PGID | — | mismatch |
| Model library | directory exists, enough free space | low free space (< 100GB) | directory does not exist |
| compose template | — | edited by hand (upgrades will show a diff and ask) | — |

At the end it prints "all checks passed" if there are no failures, otherwise the number of failed checks, and the command exits non-zero.

### uninstall

1. Asks whether to stop and remove the panel container (model containers, data, and model files are unaffected); on confirmation runs `docker compose down`.
2. If `/usr/local/bin/llamapad` points at this installation, it is removed too (via sudo if needed).
3. Reports "the container is gone; the install directory is kept", then asks again whether to also delete the install directory.
4. If yes: a model library inside the install directory triggers a warning that it will be deleted too, while one outside is reported as kept; every top-level entry in the install directory that is not a known llamapad artifact is listed as a "foreign file" (these are deleted too); you must type the install directory's name to confirm, and a mismatch aborts the deletion.
5. Once confirmed, `safe_remove_home` performs the actual deletion (see "File guards").

### help / version

`llamapad help` (or `-h`/`--help`) prints usage, every command, and every option. `llamapad version` prints the script version (`LLAMAPAD_SCRIPT_VERSION`).

### Main menu items

Running an already-installed `llamapad` with no command opens the arrow-key menu, in this fixed order: **Start/Restart** (the label switches based on whether the panel is currently running), Stop, Status, Logs, Change configuration, **"Build image" only if a repo can be located**, then Upgrade, Check environment, Uninstall, Exit. The header shows the script version, the current image (a Hub image shows its version and an update hint if one is available; a local/built image shows the full image reference), the install directory, the panel's running state, the running model, and one access URL.

## Install state detection

**Install directory resolution priority**: `--dir` > the `LLAMAPAD_HOME` environment variable (this is what the launcher exports) > the directory the script file itself lives in (only when the script's own file can be read, i.e. not under `curl | bash`). This priority only applies to *finding an existing install*; the **default directory for a new install** only comes from an explicit `--dir` or `LLAMAPAD_HOME` (`/opt/llamapad` is the further fallback default); it never falls back to the script's own directory, otherwise running the script straight from the repo would default to installing into `deploy/`.

**Directory state** (`dir_state`):

| State | Condition | Behavior |
|---|---|---|
| `installed` | `.llamapad-state` exists | goes straight to the management menu/command |
| `adopt` | no `.llamapad-state`, but `docker-compose.yml` or `.env` exists | goes to the adoption flow |
| `empty` | neither exists | goes to the fresh install wizard |

`.llamapad-state` is written **last** in `apply_install` (the write path shared by fresh installs and adoption), precisely so a half-failed install, when rerun, is judged `empty`/`adopt` and goes through the wizard again instead of being mistaken for "already installed" and skipped.

**Running a management command while not installed** (`start`/`stop`/`restart`/`status`/`logs`/`config`/`upgrade`/`doctor`/`uninstall`) reports "not installed" and suggests installing first or passing `--dir`; **`build` is the only exception**: it only needs a locatable repo and Docker, not an existing install (see "build" above).

**Checking install state manually**:

```bash
cat /opt/llamapad/.llamapad-state   # read the state file directly
llamapad status                     # panel container state, image, listen address
llamapad doctor                     # a full environment check
llamapad version                    # the script's own version
```

## Install directory structure and files

Default install directory `/opt/llamapad`, default port `28960`.

| Path | Description |
|---|---|
| `llamapad.sh` | a copy of the script itself (copied/downloaded in during install; the `llamapad` command always runs this copy, not the one you originally downloaded) |
| `docker-compose.yml` | the main compose file, written byte-for-byte from an embedded template |
| `docker-compose.gpu.yml` | the GPU overlay, active only when `.env`'s `COMPOSE_FILE` includes it |
| `.env` | deployment parameters, `chmod 600`; safe to edit by hand; the script replaces keys in place, keeping order, comments, and any extra variables |
| `.llamapad-state` | the script's own state record (not read by compose); every key is listed below |
| `data/` | mounted into the container as `/app/config`: `panel.yaml`, `panel.db`, YAML snapshots, logs, and other panel data |
| `models/` | the default model library location (can be relocated in the wizard or via `config`) |
| `backups/` | `chmod 700`; holds pre-adoption file backups (`adopt-<timestamp>/`), backups taken before replacing a template, and backups taken before a self-update |

Key `.env` variables:

| Variable | Meaning |
|---|---|
| `LLAMAPAD_IMAGE` | image repository name (omitted means the Hub image `lancelrq/llamapad`) |
| `LLAMAPAD_VERSION` | image tag/version (required) |
| `PANEL_ADMIN_PASSWORD` | admin password (required) |
| `DOCKER_GID` | `docker.sock`'s gid (required; re-synced on every start) |
| `PUID` / `PGID` | container runtime identity |
| `PANEL_BIND` / `PANEL_PORT` | listen address and port |
| `MODELS_DIR` | model library path (relative to the install directory, or absolute) |
| `COMPOSE_FILE` | whether the GPU overlay is included |
| `TZ` | container timezone |
| `PANEL_LLM_BASE_URL` / `PANEL_LLM_API_KEY` / `PANEL_LLM_MODEL` | external LLM (optional) |

`env_set` only replaces the first line with a matching key in place (removing any duplicates), appending if the key is missing, and leaves everything else untouched, so hand-editing `.env` is safe.

All `.llamapad-state` keys:

| Key | Meaning |
|---|---|
| `installed_at` | install completion time (UTC) |
| `template_version` | the compose template version currently written |
| `compose_sha256` | checksum of `docker-compose.yml` (used to detect hand edits during upgrades) |
| `gpu_compose_sha256` | checksum of `docker-compose.gpu.yml` |
| `image_source` | `hub` / `local` / `build` |
| `build_repo` | the repo path recorded when `image_source=build` |
| `adopted_from` | the backup directory path from an adoption |
| `update_checked_at` | timestamp of the last Docker Hub version lookup |
| `update_latest` | the latest stable version found |

Temporary files you may see during operation (normally cleaned up automatically, no action needed): `.env.tmp.*`, `.llamapad-state.tmp.*` (used by `env_set`/`state_set`), `.llamapad.sh.new` (self-update download in progress), `.llamapad.sh.tmp` (`place_self` in progress), `.llamapad-launcher.tmp` (launcher install in progress), `.docker-compose*.yml.new` (template sync in progress).

## File guards and safety mechanisms

**Paths forbidden as an install/delete target** (`path_forbidden`): the empty string, `/`, `$HOME`, any path containing a `/../` segment or ending in `/..`, and the following system/mount-top-level directories themselves (exact match; subdirectories are unaffected, except `/usr`, whose subdirectories are rejected too):

```
/opt  /usr  /usr/*  /home  /root  /etc  /var  /bin  /sbin
/lib  /lib64  /boot  /srv  /mnt  /media  /data  /tmp  /proc  /sys  /dev  /run
```

Other guard mechanisms:

- **Path format**: the install directory cannot contain spaces or colons.
- **Non-empty directory warning**: an existing, non-empty target directory lists up to 10 entries and suggests an empty directory instead, requiring a second confirmation to proceed.
- **Permission checks**: `home_access_ok` (for management commands: the install directory must be writable, and `.env`, if present, must be readable and writable) and `adopt_access_ok` (for adoption: the directory and any existing `docker-compose.yml`/`docker-compose.gpu.yml`/`.env` must all be readable and writable) fail with a suggestion to use `sudo llamapad`, rather than the script guessing and changing ownership itself.
- **Compose template consistency**: the embedded `tpl_compose`/`tpl_compose_gpu` must be byte-for-byte identical to `deploy/docker-compose.yml`/`deploy/docker-compose.gpu.yml` in the repo (enforced by tests); every template write records its checksum in `.llamapad-state`. During an upgrade, if the template version has increased, it re-compares: if the on-disk checksum still matches the recorded one (untouched by hand), it replaces silently; otherwise it shows a `diff -u` and asks (**defaulting to keeping the existing file**), backing it up to `backups/` before any replacement; if the rest of the upgrade later fails (e.g. `compose pull` fails), this template replacement and its checksum record are rolled back.
- **`.env` value validation**: any value containing a single quote or a newline is rejected outright, because the value is written wrapped in single quotes and neither can be safely expressed that way.
- **Self-update guards** (`self_update`): the download is checked with `bash -n` first; then matched exactly against the full line `LLAMAPAD_SCRIPT_VERSION="<target>"`; any mismatch is treated as bad content and discarded; the old script is backed up to `backups/llamapad.sh.<timestamp>` before being replaced; a Ctrl-C during download/verification cleans up the half-downloaded temp file (`.llamapad.sh.new`) before exiting.
- **`place_self` download fallback**: when the script's own file cannot be read (under `curl | bash`), it downloads by the tag matching its own version (`vX.Y.Z`), falling back to the `main` branch if that tag does not exist, and always runs `bash -n` on the result before writing it to disk.
- **The model library is never chowned by mistake**: only a model directory the wizard determines to be newly created gets its ownership aligned to the runtime identity; an existing model library (often hundreds of GB) is never touched.
- **Uninstall guards** (`safe_remove_home`): before deleting the install directory, it double-checks: the target must not match `path_forbidden`, and `.llamapad-state` must exist (proving it really is this script's own install directory); and it requires the user to type the directory name to confirm; every top-level "foreign" file not recognized as a known artifact is listed beforehand as something that will also be deleted; a model library inside the install directory triggers an extra warning.
- **The launcher only asks before overwriting when it points elsewhere**: if `/usr/local/bin/llamapad` already points at this install directory, the overwrite prompt is skipped entirely.
- **Terminal state restoration**: the interactive menu temporarily disables terminal echo/line buffering and hides the cursor; on normal exit, on Ctrl-C/kill, or on receiving `INT`/`TERM`, a `trap` always restores the terminal to its original state, so it is never left unusable.

## Environment variable overrides

| Variable | Meaning | Default |
|---|---|---|
| `LLAMAPAD_HOME` | install directory (exported by the launcher) | none (falls back to the script's own directory) |
| `LLAMAPAD_LANG` | interface language | none (falls back to `LC_ALL`/`LANG`) |
| `LLAMAPAD_RAW_BASE` | base URL for downloading the script itself / self-updates | `https://raw.githubusercontent.com/LanceLRQ/llamapad` |
| `LLAMAPAD_HUB_TAGS_URL` | Docker Hub API URL for the version tag list | `https://hub.docker.com/v2/repositories/lancelrq/llamapad/tags?page_size=100` |
| `LLAMAPAD_READY_TIMEOUT` | seconds to wait for the panel to become ready after start | `60` |
| `LLAMAPAD_BIN_DIR` | where the command launcher is installed | `/usr/local/bin` |
| `LLAMAPAD_DOCKER_BIN` | docker binary name/path (test injection) | `docker` |
| `LLAMAPAD_SUDO` | sudo binary name (test injection) | `sudo` |
| `LLAMAPAD_NVIDIA_SMI` | nvidia-smi binary name/path (test injection) | `nvidia-smi` |
| `LLAMAPAD_DOCKER_SOCK` | docker.sock path (test injection) | `/var/run/docker.sock` |
| `LLAMAPAD_SYSFS` | `/sys` path (test injection) | `/sys` |
| `LLAMAPAD_PROC` | `/proc` path (test injection) | `/proc` |
| `LLAMAPAD_ETC` | `/etc` path (test injection) | `/etc` |
| `LLAMAPAD_TTY` | interactive terminal device path (test injection); `-` reads from the inherited stdin | `/dev/tty` |
| `LLAMAPAD_PLAIN` | set to `1` to force the plain numbered-menu mode (no ANSI/TTY cursor control) | none (auto-detected) |
| `LLAMAPAD_SKIP_PLATFORM_CHECK` | set to `1` to skip the "must be Linux" check (for tests) | none |
| `LLAMAPAD_SOURCE_ONLY` | set to `1` so the script only defines functions and does not run `main` (for `source`-based tests) | none |
| `NO_COLOR` | any value disables terminal colors (not `LLAMAPAD_`-prefixed, but commonly used alongside this script) | none |
| `HTTP_PROXY` / `HTTPS_PROXY` (either case) | passed through to `docker build --build-arg` during `build` | none |

The following three are **internal, cross-version interfaces used only by the script itself to pass upgrade state between two processes during a self-update; do not set them manually**:

| Variable | Purpose |
|---|---|
| `LLAMAPAD_UPGRADE_STAGE` | marks the second-stage process `exec`'d into after a self-update |
| `LLAMAPAD_UPGRADE_CONFIRMED` | marks that the upgrade was already confirmed in stage one, so stage two does not ask again |
| `LLAMAPAD_UPGRADE_REVERT_IMAGE` | when switching from a local image to the Hub image, records the original image name for rollback on failure |

## Troubleshooting

| Symptom | Fix |
|---|---|
| docker needs sudo to run | the script auto-detects this and runs docker commands through sudo as needed (may prompt for a password); to avoid sudo, add the current user to the `docker` group and log in again |
| Rootless Docker detected | not supported yet (the panel needs to mount `/var/run/docker.sock`); use a standard (non-rootless) Docker install instead |
| `docker compose` v2 plugin missing | install it per https://docs.docker.com/compose/install/linux/ |
| GPU enabled but no NVIDIA runtime | install `nvidia-container-toolkit`, or disable GPU with `llamapad config` |
| Port already in use | pick a different port with `llamapad config`, or stop whatever is holding it |
| `data/` owner does not match the runtime identity | `llamapad start`/`doctor` detect this and offer to fix it; or manually `chown -R <PUID>:<PGID> data` |
| Restricted network, cannot reach GitHub / Docker Hub | point script downloads at a reachable mirror via `LLAMAPAD_RAW_BASE`; configure `registry-mirrors` or a proxy for Docker if image pulls fail; use `llamapad upgrade --to <version>` to skip the latest-version network lookup |
