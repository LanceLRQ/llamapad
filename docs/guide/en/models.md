# Model Management

## Running multiple models

The panel can run several models at the same time. Starting a model doesn't stop any other running model; clicking "Start" again on a model that's already running rebuilds its container. Whether VRAM is enough is your call; see the VRAM warning below. If a model genuinely doesn't fit, llama.cpp errors out on its own and the start progress dialog shows why.

### Ports and container names

Each running model takes one host port and one container name. The model's own override wins; without one, the default config applies (`host_port: 18080`, `container_name: llama-server`). If the port is already taken at start, by another running model or by another program on the host, the panel shifts to the next free port. If the container name clashes with another running model, `-<model name>` is appended.

So when several models run together, the one started later may end up on a different port than its config says. The actual port is what the models home page's "Running" section and the models list show; both offer "Open llama UI" and "Copy address". For a model that needs a fixed port (an nginx reverse proxy or a client connecting directly), give it its own port that no other model uses. When you edit a model config whose port matches another model's, the form shows a hint but doesn't block saving.

### Default model

API relay requests without a `model` field go to the default model; the Chat and Logs pages also open on it, and with several models running you can switch from the page header. The first model you start becomes the default automatically; with several models running, click "Set as default" on a runtime card in the models home page's "Running" section to change it.

The default model lives only in the panel process and isn't written to the database. When the default model is stopped or exits unexpectedly, the earliest-started model that's still running takes over; once everything is stopped there's no default. After a panel restart the default is picked the same way. Restarting the default model doesn't change the default.

### Start/stop exclusivity and running-model restrictions

Start/stop requests for the same model are mutually exclusive: if the previous request hasn't finished, a second request for the same model is rejected outright (HTTP 409) rather than queued. Queuing would let a burst of clicks take effect one after another in the background, with hard-to-predict results; rejecting outright and retrying later is clearer. Starts and stops for different models don't affect each other and can run at the same time.

A running model carries extra restrictions: deleting its config, changing its namespace, and moving its physical files are all blocked, each returning 409. A separate case returns 423: the file you're moving is shared with *another* running model and is locked by it; stop that model first. The shared premise: something a container is actively using can't be changed while it's in use.

## Status and readiness

Status badges in the model list:

| Status | Meaning |
| --- | --- |
| Running | The model's container is currently up (even if the panel itself has restarted, it can still re-identify this state) |
| Ready | Not running, and the GGUF file (and mmproj, if configured) can both be found on disk |
| Missing file | The main GGUF file is missing; the model can't be started |
| Missing mmproj | The GGUF is present, but the configured mmproj projector file is missing |

**"Running" in the list only means the container is up; it doesn't mean llama-server is actually listening on its port and able to serve requests yet**, as covered in [Quick Start](./quickstart.md). Real readiness probing is only used by the startup progress dialog and the Chat page, to decide whether to show a loading state; the "Running" badge in the list doesn't change based on readiness.

If a model is running and you save its config again afterward, the list and edit page will show a "Config changed" notice: it means the running container is still using the parameters it started with, and the new parameters won't take effect until you restart that model; saving a config never hot-updates a running container.

## VRAM warnings before starting

The progress dialog that appears when you click "Start" first fetches this model's historical run data; if **the currently free VRAM is less than the peak net VRAM increase observed for this model in past runs**, an amber warning appears at the top. This is only a warning, not a hard block; VRAM usage depends on quantization, context length, KV cache type and other factors, and the panel can't predict it exactly; hard-blocking would only get in the way of legitimate operations that would actually work. If it genuinely doesn't fit, llama.cpp will error out on its own, and the normal startup-failure flow handles that fine. If there's no run history, or GPU readings aren't available (NVIDIA Container Toolkit isn't installed), no warning is shown.

While other models are running, "currently free VRAM" already excludes what they use. Runs that overlapped with another model don't count toward the historical peak: whole-card VRAM readings from that period include the other model, which would inflate the peak.

## Config editing: merging defaults with overrides

Each model's effective parameters = the global default config (maintained on the Settings page) with that model's own parameter overrides layered on top; an override only stores the fields that differ from the default, and any field not overridden follows the default. Change a global default once (say, to standardize the batch size), and every model that hasn't individually overridden that field picks it up automatically, no need to edit each one. The "Effective parameters" preview on the edit page shows exactly the merged final values, the same ones actually assembled into the llama-server command line at startup.

Config is split into four sections: Basic info (display name / namespace / GGUF and mmproj paths), Docker (container name / port / image / GPU), Performance (context size, GPU layers, K/V cache type, etc.), and Sampling (temperature, Top-p, Top-k, etc.). A namespace is only a config grouping label and is unrelated to which disk directory a file actually sits in; changing a namespace never moves any files; a GGUF path supports shard globs; the wildcard replaces the whole sequence suffix rather than pinning one shard (e.g. `main/Qwen3-30B-Q4_K_M-*.gguf`), and can reference the same physical file from multiple namespaces.

Both the Performance and Sampling sections carry a preset picker (the three built-in quick presets plus any param presets you've saved yourself). Applying one only patches in the fields the preset actually specifies, leaving everything else as-is; you can also save the values currently filled in as a new preset for reuse later, on this model or another. This picker is the same component with the same behavior on the edit page, the clone page, and step 2 of the new-model wizard.

Deleting a model config only deletes that model's config record (including all parameter overrides); the GGUF file itself stays on disk untouched. This is the outermost of three layers of delete semantics (config / file / namespace); the boundaries of the other two are covered in [Files & Namespaces](./files.md).

## Reasoning effort

This is a newer config field, and its semantics don't quite match common intuition, so it's worth spelling out:

**Which values are allowed varies by model: the panel reads the actual supported levels from this GGUF's embedded chat template each time, rather than looking up a hardcoded table by model name.** Different packagings of the same model family can allow different ranges; for example, one modified template maps `high` to an additional `xhigh`, while another version has no such mapping. The panel checks whether the template references the `reasoning_effort` or `reasoning_strength` variable names, and only considers a model to support this feature if it finds one; it then tries to parse out which specific levels are allowed (`minimal` / `low` / `medium` / `high` / `xhigh` / `max`). When it can't parse them, it shows the full enum and leaves it to you to judge which ones actually work.

"Follow the template's own default" (value `inherit`) in the selector is always available, and is never sent to llama.cpp as a parameter; picking it hands the decision entirely to the template's own default behavior.

Three edge cases worth knowing about:

- **The template doesn't recognize this variable at all**: any value you pass is silently ignored, the container starts up and passes its health check normally; configured or not makes no difference. llama.cpp only acts on variables the template actually reads
- **The template recognizes the variable but validates its range**: if you pass a value outside what the template allows, the container still starts up and passes its health check normally; **the error only surfaces as an HTTP 500 when you actually send an inference request carrying this parameter** (the error message comes from the template's own validation and looks like a jinja error). When saving from the edit page, and before every start, the panel validates against the value range the template actually allows and blocks obviously out-of-range values (the new-model wizard and cloning skip this: the model isn't in the database yet, so its template can't be read; an invalid value there is caught later, on the next save from the edit page or at startup); but if the panel can't determine whether a model supports this feature (no embedded template, or it's supported but the specific levels couldn't be parsed), it won't force a block; it will only show a hint
- **When "Thinking mode" is off**, the reasoning effort selector is disabled: this parameter depends on the "enable thinking" toggle, and configuring it has no effect once thinking is turned off, so its value is no longer validated on save or at startup either

## MTP acceleration

MTP (multi-token prediction) is a form of speculative decoding supported by llama.cpp: the model drafts a few tokens at a time and the main model verifies them together, so generation is faster when the drafts are accepted. The cost is some extra VRAM, which the panel estimates at about 2GB. The edit page has a separate "MTP acceleration" section with three controls: an "Enable MTP" switch, the draft depth, and the draft weight.

**The panel decides whether a weight carries MTP layers from its GGUF metadata, not its file name.** File names proved unreliable in testing: a name containing MTP may be a complete main model or just a draft weight, while a name without MTP may already embed MTP layers. The panel sorts downloaded weights into three kinds:

| Kind | How it's detected | How to use it |
|---|---|---|
| Main model with embedded MTP layers | Metadata declares MTP layers and the tensor count matches a full model | Just turn the switch on and leave the draft weight empty. The repo page and file picker label it "Built-in MTP" |
| MTP draft weight | Metadata declares MTP layers, but there aren't even enough tensors for a single layer | Only usable attached to a main model, never as the main model. The file picker labels it "MTP draft weight", and it's left out of the "Create config" candidates |
| Regular model | Metadata declares no MTP layers | To use MTP, you must link a matching draft weight under "Draft weight" |

The edit page shows a hint based on the main model's kind, but the switch itself can always be turned on. Only one case is actually blocked: **MTP is on, the main model has no MTP layers, and no draft weight is linked**. llama.cpp refuses to start with that config, so the panel reports the error before stopping the old container, rather than stopping a running model and then failing. The other cases only warn:

- A draft weight is linked but the switch is off: the file has no effect and isn't passed in the launch arguments
- A draft weight was picked as the main model: that config can't run; switch back to a complete main model
- The linked draft weight file is missing: this blocks startup only while the switch is on; with the switch off, startup isn't affected

The draft depth is how many tokens are drafted at a time, from 1 to 16, defaulting to 2. The best value depends on your GPU and quantization, and a larger value isn't necessarily faster, so start from the default and measure.

Downloads and config creation support draft weights too: the download wizard suggests ticking the repo's MTP draft weights (remote files can't have their metadata read yet, so this is only a guess based on an `MTP/` directory or an `mtp-` prefix, and never enforced); batch config creation lets you choose a draft weight per row, and ticking one also turns the MTP switch on; while the MTP switch is on, the model config list flags a linked draft weight that is missing from disk, so you find out before clicking start.

## The difference between cloning and the new-model wizard

"Save as new template" (in a model row's ⋯ menu) pre-fills a new creation form with the source model's entire config; nothing is saved until you submit, so you're free to change parameters or files before creating it. It's unaffected by the source model's running state (cloning only creates a new config record; it never touches any container or disk file), so you can clone a model even while it's running.

The new-model wizard (`models/new`) has two steps: first pick a file, either an existing one on disk or one you just downloaded; then fill in basic info and parameters. The difference between the two comes down to the starting point: cloning starts from an existing config (with every parameter pre-filled), while the wizard starts from a file. Parameters can start from scratch, or from a preset: either one of the panel's three built-in quick presets ("Conservative" / "Balanced" / "Full offload") or one of your own saved param presets (managed from [Settings Reference](./settings.md)); either way you can still fine-tune by hand after applying one.

## HuggingFace discovery

Below the "Running" section and the recently-updated repos, the models home page has a third section: HuggingFace discovery. By default it lists the repos trending on HuggingFace right now, using the same ranking as the site's own Trending list, and always restricted to repos tagged `gguf` — the panel only runs llama.cpp, so listing anything else would just set you up to fail.

The search box in the section header searches in place about 0.4 seconds after you stop typing; clearing it returns to the trending list. The search term is not written into the address bar: this section is an exploration entry point on the home page, not a shareable, go-back-able page of its own, and the browser's Back should still leave the home page rather than page through your search history inside it.

Each card shows the trending score, likes, downloads, task type and last-updated time, with two ways out: "Download" pre-fills the repo into the new download dialog and probes its quantization groups once automatically, and the arrow button on the right opens the repo on HuggingFace itself. A repo you already have a repo profile for is marked with an "In library" badge, and its main button becomes "View repo" straight to the detail page — running into a repo you already own is common on a trending list, and the badge is there so you don't build a second profile for it. When the results fill a screen, a full-width button appears below the grid to send you to the listing page on HuggingFace; the panel does no paging of its own, and no faceted filtering by author, parameter count or quantization type, because the filters over there are far more complete.

Every outbound link follows the mirror endpoint in effect from the settings page: with `hf-mirror.com` configured, links open on the mirror; only without one do they go to the official site.

The trending list is cached for **30 minutes** (override with the `PANEL_HF_TRENDING_TTL_MINUTES` environment variable; set it to `0` to never expire automatically and rely on manual refresh only), and the refresh button in the section header bypasses the cache and forces a refetch. This cache lives only in the panel process's memory and is not persisted, so the list has to be fetched again after a panel restart. If a fetch fails while the cache still holds the previous batch, the old cards keep showing, with a note above the grid saying how old the cache is and why this refresh failed; only when there's no older data at all does the whole section turn into an error with a "Retry" button. Search results are not cached.

## Next steps

- Where models come from and how downloads work: [Model Downloads](./downloads.md)
- Namespaces and file directories: [Files & Namespaces](./files.md)
