# Changelog

**English** | [中文](CHANGELOG_zh.md)

This file records the changes in each llamapad release, newest first. Versions follow [Semantic Versioning](https://semver.org/); until 1.0 these are preview releases, and features and config formats may still change.

## [0.2.1] - 2026-09-24

### Added

- `GET /api/v1/runtime/status` gains a `starting` field listing models whose start or restart request hasn't returned yet, along with their current stage: `preparing` (validation, removing the old container), `pulling` (the image isn't local and is being pulled), or `creating` (the container exists and is starting). Previously, while an image was being pulled the container didn't exist yet, so the status endpoint didn't show the model at all and clients assumed nothing was starting. See the runtime/status section of the API docs

## [0.2.0] - 2026-09-22

The focus of this release is **running multiple models at once**: several models can run side by side, and the inference relay dispatches each request by its `model` field. It also adds MTP speculative decoding and a models home page with HuggingFace discovery.

### Added

- **Running multiple models**
  - Starting a model no longer stops the others. When a container name or port clashes with a running model, or the host port is already taken, it shifts automatically; the actual port is shown in the list and on the running cards
  - Default model: requests to the inference relay that don't name a `model` go to it, and you can change it from the running section of the models home. The default model lives only in the panel process; after a panel restart it's picked again from the running models
  - The inference relay routes by the request body's `model` field or the `?model=` query parameter; a model that's configured but not running returns 404; `GET /v1/models` lists every running model
  - The Chat page lets you pick which running model to talk to; container logs can be pinned to one model; the status bar shows the default model and how many others are running
  - The model config form warns when a port matches another model's (saving isn't blocked; the port shifts at startup)
- **MTP speculative decoding**
  - Whether a weight carries MTP layers is decided from its GGUF metadata, sorting weights into "main model with embedded MTP", "MTP draft weight" and "regular model"; the file name is only a fallback hint
  - A new "MTP acceleration" section on the edit page: an on/off switch, draft depth (default 2), and a linked draft weight (`draft_file`)
  - The repo page and file picker tag weights with MTP labels; draft weights are left out of the "Create config" candidates
  - The download wizard suggests ticking a repo's draft weights; batch config creation lets you link a draft weight per row
  - `draft_file` is carried through everywhere: import/export, moving and renaming files, moving namespaces, and reference checks before deletion
  - When MTP is on, the weight has no MTP layers and no draft weight is linked, startup fails up front instead of first stopping the running container
- **Models home**
  - `/models` is now a models home page showing running models, recently updated repos, and a HuggingFace discovery section
  - The discovery section lists trending GGUF repos on HF by default and supports in-place search; each card goes straight to a download, and repos you already have an archive for are marked
  - The trending list is cached in the panel process for 30 minutes (tunable with `PANEL_HF_TRENDING_TTL_MINUTES`), falling back to the previous batch when a fetch fails
- The repo page's weight list supports filtering by file name and by quantization level
- When issuing an API Token you choose whether to save its plaintext: saved, it can be revealed and copied from the list any time; not saved, it's shown only once at issue time (the default is not to save)
- The new-download dialog can be pre-filled with a repo and probes its quantization groups automatically

### Changed

- The model config list moved from `/models` to `/models/profiles`; the two groups in the secondary navigation swapped places, and "Repos" was renamed "HuggingFace"
- The overview page's running-status card is now a summary; stop, restart and set-as-default moved to the running section of the models home
- The model list dropped the "Switch" action; running rows show the actual port and service entry points, and the start-progress dialog follows each model's own status and logs
- **The built-in default context length dropped from 131072 to 65536.** Models that don't set `ctx_size` themselves will use the new default on their next start; set it explicitly for models that need a long context
- The inference relay now always reads JSON request bodies by the bytes actually received, up to 64MB, and returns 413 (OpenAI-style error) beyond that. Previously, requests over 4MB or without `content-length` weren't read at all, and with several models running they could be sent to the default model by mistake
- Saving on the edit page now reports the result with a global notification, and returns to the config list on success
- The file picker is now a two-pane, multi-purpose file browser; the start dialog is wider and truncates logs half as much; the new-model wizard's back button depends on where you came from

### Fixed

- With several models running, the second running model is also protected by the "running" lock
- Run records are kept per model: dangling records, crash detection and reconciliation no longer assume a single model; runs that overlapped with other models don't write aggregate metrics, so VRAM and speed data don't contaminate each other
- With thinking mode off, a reasoning effort outside the template's levels no longer blocks saving or starting
- The Chat page's parameter bar reads llama-server's live parameters for the selected model instead of always comparing against the default model
- Removed a misleading `gpu_layers` warning; the input now shows the number of offloadable layers as a placeholder
- Dialog widths were locked at 384px by a base style
- Large counts (downloads and the like) didn't roll over from 1000k to M

## [0.1.0] - 2026-09-16

The first public preview release.

### Added

- **Model management**: start, stop and switch models in one click (Docker + GPU acceleration), one model running at a time
- **Parameter editing**: form-based editing in the panel showing the merged final parameters; YAML import/export with automatic snapshots; parameter presets
- **Namespaces**: custom grouping, GGUF files shared across spaces, reference-safe deletion
- **Model downloads**: HuggingFace (official and mirror) and direct URLs, resumable with sha256 verification, proxy configurable in the panel; repos are auto-grouped by quantization, and split files are grouped automatically
- **README and recommended parameters**: extracts recommended parameters from a HF repo's README, with optional AI parsing through a local or external model
- **Setup wizard and file manager**: pick a repo, choose files and save the config in one pass; directory browsing, with reference checks on move and rename
- **Monitoring**: container CPU and memory, llama.cpp inference metrics, GPU memory and temperature, host disk and network, live logs, run history and a VRAM warning before starting
- **Playground**: a built-in chat page; `/llama-proxy/*` relays the inference API, with per-model reasoning effort mapping
- **Auth and API**: login protection, API Tokens, and a REST API
- **Bilingual UI** (Chinese/English) with a built-in documentation center
- **Deployment script** `llamapad.sh`: one-command install, an interactive management menu, and commands such as `start`, `stop`, `status`, `logs`, `config`, `upgrade` and `doctor`

[0.2.1]: https://github.com/LanceLRQ/llamapad/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/LanceLRQ/llamapad/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/LanceLRQ/llamapad/releases/tag/v0.1.0
