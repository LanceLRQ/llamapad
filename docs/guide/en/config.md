# Config Format & Migration

The panel's config lives in a database; YAML is its export format. This page covers what that YAML looks like, what each field means, and how to migrate from the bash version of llama-launcher.

## Where this file comes from

There are three ways to get it:

- **Auto snapshot** — once auto snapshot is turned on in the Settings page, every config change writes the full config to `data/export/latest.yaml`. This is the least-effort way to back it up — checking that directory into git gives you a config record with history.
- **Export all** — the Settings page's "Export all" button packs a zip under `data/export/`, containing one `llamapad.yaml` plus one YAML file per model.
- **Export a single model** — only available through the endpoint, with no entry point in the UI. Good for sharing a single model's config or moving one model between two machines; usage is covered in [Panel API](./api.md).

**These files are all exports — editing them doesn't affect the panel.** To make a change take effect, you need to go through the Settings page's import feature to load the edited content back in. Directly editing `latest.yaml` only gets it overwritten on the next config change.

## File structure

```yaml
default_config:
  docker:
    image: ghcr.io/ggml-org/llama.cpp:server-cuda
    container_name: llama-server
    model_volume: /srv/llama/models:/models
    host_port: 18080
    container_port: 8080
    gpu: all
  server:
    host: 0.0.0.0
    ctx_size: 131072
    gpu_layers: 99
    flash_attention: on
    batch_size: 4096
    ubatch_size: 1024
    cont_batching: true
    cache_type_k: q4_0
    cache_type_v: q4_0
    enable_thinking: false
    repeat_penalty: 1
    presence_penalty: 1.5
    min_p: 0
    top_k: 20
    top_p: 0.8
    temp: 0.7
    reasoning_effort: inherit
  api:
    effort_aliases: {}
    effort_rounding: down
models:
  - name: qwen3-30b
    display_name: Qwen3 30B
    namespace: main
    gguf_file: main/Qwen3-30B-Q4_K_M.gguf
    overrides:
      server:
        ctx_size: 32768
namespaces:
  - main
repos:
  - repo: unsloth/Qwen3-30B-GGUF
    baseDir: hf
presets:
  - name: conservative-long-context
    description: For 384K long-context workloads, trading some throughput for stability
    server:
      ctx_size: 393216
      temp: 0.6
      top_p: 0.95
```

Five top-level sections: `default_config` is the global default parameters, `models` is the list of model configs, `namespaces` is the list of namespaces, `repos` is the registration info for repo profiles, and `presets` is a list of reusable parameter presets.

Both the `repos` section and the `presets` section only appear in a full export; they're absent when exporting a single model.

## default_config

### The docker section

| Field | Value | Description |
| --- | --- | --- |
| `image` | Image reference | Which llama.cpp image to use |
| `container_name` | Starts with a letter or digit, may contain `_.-` | The model container's name |
| `model_volume` | `host path:in-container path` | How the model library gets mounted into the container. **Setting it at the `default_config` level has no effect** (see the note below); only a value under a specific model's `overrides.docker` is used verbatim |
| `host_port` | 1–65535 | The port the model service is published on, on the host |
| `container_port` | 1–65535 | The port listened on inside the container |
| `gpu` | `all` / `none` / `device=0,1` | Which GPUs to use |

The following are for custom images; the official image doesn't need them, and leaving them out means they're not enabled:

| Field | Value | Description |
| --- | --- | --- |
| `model_mount` | Path | The model mount point inside the container. When omitted it is always `/models` and **does not follow `model_volume`** — if you override `model_volume` with a different container-side path, you must set `model_mount` to match, or the model path argument will still point at `/models` and the container will start but find no file |
| `entrypoint` | String array | Overrides the image's own entrypoint |
| `extra_args` | String array | Appended after the auto-generated arguments |
| `args_override` | String array | Completely replaces the auto-generated arguments |
| `env` | `KEY=value` array | Extra environment variables |

`extra_args` and `args_override` are mutually exclusive: the former appends, the latter replaces the whole thing.

**About `model_volume`**: the schema requires this field at the `default_config` level (it has to be present and well-formed), but the panel doesn't read it when starting a model — the host path used to mount the model library comes from the `PANEL_MODELS_HOST` environment variable, `paths.models.host` in `panel.yaml`, or the panel's own auto-discovery, and the settings page has no entry for editing it. Changing the value here changes no mounting behavior. Only under a specific model's `overrides.docker.model_volume` is it used verbatim as that model container's mount argument.

### The server section

This section corresponds to llama-server's startup parameters.

| Field | Value | Description |
| --- | --- | --- |
| `host` | Listen address | Usually `0.0.0.0` |
| `ctx_size` | Integer ≥0 | Context length, affects VRAM usage |
| `gpu_layers` | Integer ≥0 | Number of layers placed on the GPU; `99` means put as many as possible |
| `split_mode` | `none` / `layer` / `row` / `tensor` | Multi-GPU split mode; unset follows the llama.cpp default. `row` is deprecated upstream |
| `tensor_split` | Comma-separated numbers | Per-GPU memory allocation ratio, e.g. `3,1`; the order follows the in-container GPU index |
| `main_gpu` | Integer ≥0 | Main GPU index, starting at 0; this is the in-container index, not the host GPU index |
| `flash_attention` | `on` / `off` | Note these are the two strings, not `true` / `false` |
| `batch_size` | Integer ≥1 | Batch size |
| `ubatch_size` | Integer ≥1 | Micro-batch size |
| `cont_batching` | Boolean | Continuous batching |
| `cache_type_k` | See below | K cache quantization type |
| `cache_type_v` | See below | V cache quantization type |
| `enable_thinking` | Boolean | Whether to enable thinking mode |
| `repeat_penalty` | 0–2 | Repeat penalty |
| `presence_penalty` | -2–2 | Presence penalty |
| `min_p` | 0–1 | Minimum probability threshold |
| `top_k` | Integer ≥0 | Number of candidate tokens |
| `top_p` | 0–1 | Cumulative probability threshold |
| `temp` | 0–2 | Temperature |
| `reasoning_effort` | See below | Reasoning effort |

`cache_type_k` and `cache_type_v` accept: `f16`, `q8_0`, `q4_0`, `q4_k`, `q5_0`, `q5_k`, `q6_k`, `q8_k`. The more aggressively the cache is quantized, the more VRAM it saves — the effect is noticeable with long contexts.

`reasoning_effort` accepts: `inherit`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. `inherit` means following the model's chat template's own default without interfering — this is also the default value. Note that whether this parameter has any effect depends on whether the model's chat template reads it, and has nothing to do with the model's name.

> **Index coordinate systems**: `device=1,2` in `docker.gpu` is written in **host** GPU
> indices, but the container renumbers its visible GPUs from 0 — in the example above,
> host GPU1 becomes index 0 inside the container. `main_gpu` and `tensor_split` follow
> the in-container index order. The panel shows this mapping on the edit page; when
> hand-editing YAML you need to work it out yourself.

### The api section

This section governs the panel's rewriting behavior when acting as an inference relay — it's not part of llama-server's startup parameters.

`effort_aliases` is the reasoning-effort alias table, a string-to-string mapping — for example, turning a client-sent `high` into `xhigh`. `effort_rounding` decides what happens when a client-sent value falls outside the model's supported range: `down` picks the nearest lower level, `up` the nearest higher one, and `off` drops the field entirely so the template falls back to its own default.

Detailed rules are in the reasoning-effort relay mapping section of [Inference Interface](./inference.md).

## models

| Field | Required | Description |
| --- | --- | --- |
| `name` | Yes | The model id — lowercase letters, digits and hyphens only, globally unique |
| `display_name` | Yes | The name shown in the UI, no character restrictions |
| `namespace` | No | The namespace it belongs to, defaults to `main` |
| `gguf_file` | Yes | Path relative to the model library root, must end in `.gguf`; write a glob for a sharded model |
| `mmproj_file` | No | Path to the multimodal projector file |
| `download` | No | Where this model was downloaded from, see below |
| `overrides` | No | This model's overrides on top of the global defaults |

Both `gguf_file` and `mmproj_file` are paths **relative to the model library root** — never an absolute path. A sharded model is written as a glob, with the wildcard replacing the whole sequence suffix, e.g. `main/Qwen3-235B-A22B-Q4_K_M-*.gguf`. Putting the wildcard before the sequence segment and pinning the numbers is wrong — that only ever matches the first shard.

`download` records the source, in one of two shapes:

```yaml
download:
  source: hf
  repo: unsloth/Qwen3-30B-GGUF
  file: Q4_K_M/Qwen3-30B-Q4_K_M.gguf
  sha256: <64-character lowercase hex, optional>
```

```yaml
download:
  source: url
  url: https://example.com/model.gguf
  file: model.gguf
  sha256: <optional>
```

`overrides` has the same structure as `default_config`, but every section and every field is optional — only write the ones you want to change:

```yaml
overrides:
  server:
    ctx_size: 32768
    temp: 0.3
  docker:
    host_port: 18081
```

A field that isn't written follows the global default as it changes — change a global default once, and every model that hasn't individually overridden that field picks it up.

**Unknown fields aren't allowed inside `overrides`.** A misspelled field name isn't silently ignored — importing it fails outright and points out which field is the problem, so a mistyped parameter never quietly does nothing.

## namespaces and repos

`namespaces` is a list of namespace names — lowercase letters, digits, dots, underscores and hyphens only.

`repos` is the registration info for repo profiles, with two fields per entry: `repo` is the Hugging Face repo id, and `baseDir` is the profile directory's location relative to the model library root (an empty string means the root itself). On import, the profile directory is rebuilt from this info, so already-downloaded files get reclaimed instead of re-downloaded.

## presets

A "param preset" is a named parameter override that isn't tied to any model. Management lives in the "Model library" group of [Settings Reference](./settings.md); usage is covered in [Model Management](./models.md) and [Files & Namespaces](./files.md). Three fields per entry:

| Field | Required | Description |
| --- | --- | --- |
| `name` | Yes | The preset name, unique within one export |
| `description` | No | What it's for |
| `server` | Yes | Same fields and value ranges as `overrides.server` — only write the parameters you want to carry, unknown fields aren't allowed |

**The panel's three built-in quick presets ("Conservative" / "Balanced" / "Full offload") never get exported** — they track the code version and aren't stored in the database. The `presets` in an export only contains presets you created yourself, or saved from a repo's README recommendations. The latter kind remembers its source repo inside the app, but that field isn't carried into the export — it's meaningless once you're on another machine.

Importing the `presets` section always skips same-named entries rather than overwriting them — there's no rename-or-overwrite choice like the `models` section has. Import shouldn't quietly change a preset you're already using. A single entry failing to parse doesn't block the rest of the batch; the result lists which names were created, skipped, and failed separately.

## Manual editing and import

If you want to change config in bulk (say, standardizing the context length across twenty models), it's faster than clicking through the UI one by one to: export → edit the YAML → import.

Import lives under the "Import" entry point on the Settings page — just paste in the full YAML text. Three things to know:

**Pick the right format.** Use `llamapad` for this product's own export, `bash` for the bash version of llama-launcher's config. The panel doesn't auto-detect it — picking the wrong one gets you a parse error.

**Same-named models are handled three ways.** Skip (keep the existing one), rename on import (adds a `-1` suffix), or overwrite (replace the existing one with the imported one).

**Import runs a pre-check first.** The panel checks whether each model's referenced GGUF file exists on this machine. Missing ones are listed, letting you manually pick a replacement file already on disk for each row. You can also leave one unpicked — that row is imported with its original path as-is, the model still gets created, it just ends up with a missing file, which you can fix later on the Files page or by editing its path. This is useful for cross-machine migration, where directory layouts often don't match up.

## Migrating from llama-launcher

The bash version's config directory is usually a `default.yaml` plus a handful of per-model YAML files. The Settings page's migration entry point supports submitting multiple files at once, and the panel tells them apart by filename: `default.yaml` is parsed as the global default config, and everything else as an individual model.

Migration applies these conversions:

- **Models all land in the `main` namespace** — the bash version has no concept of namespaces.
- **File paths automatically get a prefix added** — a bare filename (no `/`) becomes `main/filename`; one that already has a directory is left as-is.
- **The GPU field is renamed** — the bash version's `docker.gpu_devices` maps to `gpu`. An empty value or `all` both become `all`, `none` stays `none`, and a GPU number list like `0,1` becomes `device=0,1`.
- **Unsupported fields are ignored** — fields unique to the bash version with no panel equivalent (e.g. `jinja`, `no_mmap`) don't fail the migration; they're listed in a warning telling you what got dropped.
- **Missing fields are filled in with built-in defaults** — anything not fully filled out in the bash version's `default.yaml` doesn't affect the migration.

**Migration doesn't do a file pre-check**, unlike a single YAML import — it won't give you a chance to remap a missing file, and paths land in the database as-is. So after migrating, check two things:

- Whether each model's GGUF file actually exists on the Models page (missing ones are flagged) — fix wrong paths on the edit page;
- Whether the model library path is configured on the new machine — that path comes from the `PANEL_MODELS_HOST` environment variable or `panel.yaml`, not from `model_volume` in the YAML (which has no effect at the default level, as noted above). The environment doctor on the settings page reports directly whether the model library path resolved.
