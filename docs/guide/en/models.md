# Model Management

## Single-model constraint

The panel runs only one model at a time. VRAM on a single GPU is an exclusive resource — running two large models at once will most likely fail to fit both. When you start a new model, the panel stops whatever is currently running before starting the target one; the models list calls this action "Switch". You don't need to manually stop one and then start another — one click does it.

Start/stop requests are also mutually exclusive: if a previous start/stop request hasn't finished yet, a second request is rejected outright (HTTP 409) rather than queued. Queuing would make it unpredictable which model ends up running; rejecting outright and retrying once it fails is clearer.

A model with a "config currently running" also carries extra restrictions: deleting its config, changing its namespace, and moving its physical files are all blocked while it runs, each returning 409. A separate case returns 423: the file you're moving is shared with *another* running model and is locked by it — stop that model first. The shared premise: something a container is actively using can't be changed while it's in use.

## Status and readiness

Status badges in the model list:

| Status | Meaning |
| --- | --- |
| Running | The model's container is currently up — even if the panel itself has restarted, it can still re-identify this state |
| Ready | Not running, and the GGUF file (and mmproj, if configured) can both be found on disk |
| Missing file | The main GGUF file is missing; the model can't be started |
| Missing mmproj | The GGUF is present, but the configured mmproj projector file is missing |

**"Running" in the list only means the container is up — it doesn't mean llama-server is actually listening on its port and able to serve requests yet**, as covered in [Quick Start](./quickstart.md). Real readiness probing is only used by the startup progress dialog and the Chat page, to decide whether to show a loading state; the "Running" badge in the list doesn't change based on readiness.

If a model is running and you save its config again afterward, the list and edit page will show a "Config changed" notice: it means the running container is still using the parameters it started with, and the new parameters won't take effect until you restart that model — saving a config never hot-updates a running container.

## VRAM warnings before starting

The progress dialog that appears when you click "Start" or "Switch" first fetches this model's historical run data; if **the currently free VRAM is less than the peak net VRAM increase observed for this model in past runs**, an amber warning appears at the top. This is only a warning, not a hard block — VRAM usage depends on quantization, context length, KV cache type and other factors, and the panel can't predict it exactly; hard-blocking would only get in the way of legitimate operations that would actually work. If it genuinely doesn't fit, llama.cpp will error out on its own, and the normal startup-failure flow handles that fine. If there's no run history, or GPU readings aren't available (NVIDIA Container Toolkit isn't installed), no warning is shown.

## Config editing: merging defaults with overrides

Each model's effective parameters = the global default config (maintained on the Settings page) with that model's own parameter overrides layered on top; an override only stores the fields that differ from the default, and any field not overridden follows the default. Change a global default once (say, to standardize the batch size), and every model that hasn't individually overridden that field picks it up automatically — no need to edit each one. The "Effective parameters" preview on the edit page shows exactly the merged final values — the same ones actually assembled into the llama-server command line at startup.

Config is split into four sections: Basic info (display name / namespace / GGUF and mmproj paths), Docker (container name / port / image / GPU), Performance (context size, GPU layers, K/V cache type, etc.), and Sampling (temperature, Top-p, Top-k, etc.). A namespace is only a config grouping label and is unrelated to which disk directory a file actually sits in — changing a namespace never moves any files; a GGUF path supports shard globs — the wildcard replaces the whole sequence suffix rather than pinning one shard (e.g. `main/Qwen3-30B-Q4_K_M-*.gguf`), and can reference the same physical file from multiple namespaces.

Deleting a model config only deletes that model's config record (including all parameter overrides) — the GGUF file itself stays on disk untouched. This is the outermost of three layers of delete semantics (config / file / namespace); the boundaries of the other two are covered in [Files & Namespaces](./files.md).

## Reasoning effort

This is a newer config field, and its semantics don't quite match common intuition, so it's worth spelling out:

**Which values are allowed varies by model: the panel reads the actual supported levels from this GGUF's embedded chat template each time, rather than looking up a hardcoded table by model name.** Different packagings of the same model family can allow different ranges — for example, one modified template maps `high` to an additional `xhigh`, while another version has no such mapping. The panel checks whether the template references the `reasoning_effort` or `reasoning_strength` variable names, and only considers a model to support this feature if it finds one; it then tries to parse out which specific levels are allowed (`minimal` / `low` / `medium` / `high` / `xhigh` / `max`). When it can't parse them, it shows the full enum and leaves it to you to judge which ones actually work.

"Follow the template's own default" (value `inherit`) in the selector is always available, and is never sent to llama.cpp as a parameter — picking it hands the decision entirely to the template's own default behavior.

Three edge cases worth knowing about:

- **The template doesn't recognize this variable at all**: any value you pass is silently ignored, the container starts up and passes its health check normally — configured or not makes no difference. llama.cpp only acts on variables the template actually reads
- **The template recognizes the variable but validates its range**: if you pass a value outside what the template allows, the container still starts up and passes its health check normally — **the error only surfaces as an HTTP 500 when you actually send an inference request carrying this parameter** (the error message comes from the template's own validation and looks like a jinja error). When saving from the edit page, and before every start, the panel validates against the value range the template actually allows and blocks obviously out-of-range values (the new-model wizard and cloning skip this — the model isn't in the database yet, so its template can't be read; an invalid value there is caught later, on the next save from the edit page or at startup); but if the panel can't determine whether a model supports this feature (no embedded template, or it's supported but the specific levels couldn't be parsed), it won't force a block — it will only show a hint
- **When "Thinking mode" is off**, the reasoning effort selector is disabled: this parameter depends on the "enable thinking" toggle, and configuring it has no effect once thinking is turned off

## The difference between cloning and the new-model wizard

"Save as new template" (in a model row's ⋯ menu) pre-fills a new creation form with the source model's entire config; nothing is saved until you submit, so you're free to change parameters or files before creating it. It's unaffected by the source model's running state (cloning only creates a new config record — it never touches any container or disk file), so you can clone a model even while it's running.

The new-model wizard (`models/new`) has two steps: first pick a file, either an existing one on disk or one you just downloaded; then fill in basic info and parameters. The difference between the two comes down to the starting point — cloning starts from an existing config (with every parameter pre-filled), while the wizard starts from a file (parameters start from scratch, or from one of the panel's three quick presets).

## Next steps

- Where models come from and how downloads work: [Model Downloads](./downloads.md)
- Namespaces and file directories: [Files & Namespaces](./files.md)
