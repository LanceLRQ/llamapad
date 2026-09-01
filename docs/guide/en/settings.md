# Settings Reference

The Settings page (`/settings`) is four fixed groups in a second-level sidebar, not a flat pile of cards:

| Group | Name | Cards it contains |
| --- | --- | --- |
| 01 | Runtime | Environment doctor, Runtime image |
| 02 | Model library | Namespaces, Download source (Hugging Face) |
| 03 | Monitoring & notifications | Network interface, Webhook notifications |
| 04 | Account & data | Account & security, Import & Backup |

Each group only fetches its data when selected (in particular, the download-source check in the Model library group and the file-tree scan in the Account group are relatively heavy operations); switching groups goes through the URL's `?tab=` parameter, so a deep link is shareable directly.

## Runtime

### Environment doctor

Clicking "Run check" triggers a one-off check, always in this order:

| Check | What it tells you |
| --- | --- |
| Docker connectivity | Whether the panel can list containers via `docker.sock` |
| models directory | Whether the directory exists and the panel's runtime identity can write to it |
| Path mapping | Whether the model library's host path resolution succeeded, and which source it came from (env var / `panel.yaml` / auto-discovery) |
| GPU | The three-state `nvidia-smi` probe result (available / probing / unavailable — unavailable is expected on a CPU-only deployment and is marked as a warning, not a failure) |
| Download source (Hugging Face) | Attempts a real connection using the currently effective Token / Mirror / Proxy config |
| Disk space | Free space on the partition backing the models root path (below 1GB is marked failed, below 5GB is marked a warning) |

The six checks are independent of each other — an error in one only affects its own result and never keeps the rest of the page's checks from showing their conclusions. This card comes first because environment problems (Docker unreachable, no permission on a directory) are usually the root cause behind most other failures, so checking them before config issues saves time.

### Runtime image

The default image used when creating and starting models; an individual model can override it in the "Image" field on its edit page. From here you can either change the image tag directly (typed into the reading card's input field and saved), pick one from the official image list and "Set as runtime image", or fully replace the container's mount point / entrypoint / launch arguments / environment variables in the "Custom image" section.

**When a change takes effect**: writes are saved immediately, but they **don't hot-update an already-running container** — if the panel detects a model is currently running, it shows a "restart the model to apply this" notice, and the change actually takes effect the next time that model is started (or restarted). Pulling an image (downloading its bytes locally) and "set as runtime image" (pointing the config at a different tag) are two independent things — pulling an unrelated tag doesn't affect a model that's currently running.

## Model library

### Namespaces

Manages grouping labels for models. Semantics worth noting:

- **Create** only registers the grouping — the disk directory is only created once something is actually put into it;
- **Rename** only changes the `namespace` field on the model configs in that namespace, and **never moves any disk files** — to rename the disk directory, go to [File Management](./files.md); blocked while a model in that namespace is running;
- **Delete** only removes the panel record; the directory and files on disk are left as-is and can be cleaned up separately on the Files page; the delete button is disabled while the namespace still has model records in it.

### Download source (Hugging Face)

Three independent dual-source config items:

**Token dual source**: the `HF_TOKEN` environment variable takes precedence over the panel's own config. When the env var exists, the panel's Token input is marked "Read-only, environment variable takes precedence," and its save/clear buttons are disabled — to switch to the panel's own config, you first need to remove this environment variable. The panel **never displays the Token in plaintext**, only a source badge (environment variable / panel config / not set) and the plaintext's **last 4 characters**.

**Mirror**: choose one of official / `hf-mirror.com` (built-in preset) / a custom URL.

**Outbound proxy dual source** (applies to Hugging Face downloads, Webhook delivery, and every outbound request from the downloader): the panel's config overrides `panel.yaml`'s `proxy` field, and takes effect **immediately on save, no restart needed**. **Clearing the panel's config falls back to whatever's in `panel.yaml`, it doesn't become "no proxy"** — `panel.yaml` itself stays a plain file and is never rewritten by the panel (you can still edit it by hand for diagnostics even if the panel won't start). A proxy address with a username and password is masked when displayed in the UI (e.g. `http://***@host:port`), and the input field never pre-fills a previous value that might contain credentials either.

After saving a proxy, it's worth clicking "Test connection" once to confirm it's actually connecting through the proxy, rather than just trusting the "saved" toast.

## Monitoring & notifications

### Network interface

Chooses which network interface host network throughput metrics are read from; defaults to auto-select (usually picks whichever interface is currently used for outbound traffic). This choice only affects the two network throughput metrics on the [Overview page](./monitoring.md) and nothing else; if no physical interface can be detected on the machine, a corresponding notice is shown.

### Webhook notifications

Pushes events like download completion or model start/stop to Bark / Telegram / WeCom, or a custom endpoint (POST JSON). The channel list is **edited as a whole table** — adding, removing, or editing a field only changes a local draft, and clicking "Save" replaces the entire server-side config at once; while unsaved, the "Send test" button is disabled, because a test request looks up the channel's saved config on the server by id, and a new but unsaved row can't be found there.

Subscriptions are grouped by event prefix (Downloads / Model start/stop / Auth / Namespaces / Config changes / File operations / Repository profiles), and **leaving all of them unchecked means subscribing to every event**, not "send nothing".

"Send test" fires off one real outbound request using a fake event and only echoes back `{ok, status}` — it **never echoes the other side's response body**. Since a channel's URL is filled in by an admin, echoing back response bodies would turn the panel into a general-purpose server-side outbound probe, which is a deliberate security restriction.

## Account & data

### Account & security

- **API Token**: the plaintext is shown **only once**, right after issuance — after that, the list only keeps the last 4 characters, for external scripts to call the panel API via `Authorization: Bearer lp_…` (see the auth section of [Inference Interface](./inference.md)). Revoking takes effect immediately (deletes the row).
- **Change password**: requires verifying the old password; changing the password does **not** revoke already-issued API Tokens (revoking is a separate action in the Token list).

### Import & Backup

- **Export all**: writes the entire current config out as a YAML zip; the path and size are echoed back after the operation.
- **Auto snapshot**: when this toggle is on, every config change automatically writes the full config to `data/export/latest.yaml` — checking this directory into a git repo gives you a continuously updated config backup, so you can diff against a previous version if something goes wrong.
- **Import**: paste a single YAML document; two formats are supported — the `llamapad` native export format (restores the full config) and `bash` (`llama-launcher`) format (imports a single model into the `main` namespace). Name conflicts can be handled by skipping / renaming on import (`-1` suffix) / overwriting. Import runs a pre-check first: if the referenced model files (GGUF / mmproj) genuinely exist on this machine, it imports directly; if any are missing, it shows a remapping table letting you manually pick a replacement file already on disk for each row — leaving a row unpicked skips it and keeps the original path as-is when saved.
- **Migrate from llama-launcher**: paste in `default.yaml` and each `configs/models/*.yaml` from the bash version's `configs` directory as individual files, and import them all in one batch. Models all land in the `main` namespace; parameters unique to the bash version surface as warnings (they don't cause the import to fail).
