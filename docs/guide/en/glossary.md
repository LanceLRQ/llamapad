# Glossary

Terms that come up repeatedly across the panel's UI and this documentation, grouped by topic. Each entry gives just enough explanation to be useful — the full story is at its linked page.

## Model files

**GGUF**
The model file format used by llama.cpp, with extension `.gguf`. A single file packs in the model weights, metadata, and chat template together, with no separate config file needed alongside it. The panel only recognizes this format.

**Quantization**
Compressing model weights from high precision down to low precision, trading some output quality for a smaller file and lower VRAM usage. The `Q4_K_M`, `Q5_K_M`, `Q8_0` you see in filenames are quantization levels: the smaller the number, the more aggressive the compression and the smaller the file; `F16` / `BF16` means unquantized. The same Hugging Face repo usually offers several levels to choose from, and which one to pick depends on your VRAM. See [Model Downloads](./downloads.md).

**Shard**
An oversized model gets published as multiple files, named like `model-00001-of-00003.gguf`. All of these files have to be present together, in the same directory, for it to start. The panel treats them as a whole group for downloading, moving, and renaming — selecting any one shard automatically brings along the rest of the group, so you never end up moving only half of it. See [Files & Namespaces](./files.md).

**mmproj**
A multimodal projector file that lets a model understand image input. It's a companion file to the main model and can't be started on its own — it needs to be specified alongside the main model in the model config. Repos usually name it starting with `mmproj`. See [Model Management](./models.md).

**Chat template**
Determines how a multi-turn conversation gets assembled into the text a model actually reads; it's embedded in the GGUF file and differs from model to model. It also determines which parameters a model accepts — the panel's reasoning-effort relay mapping decides whether a model supports `reasoning_effort` based on what the template reads. See [Inference Interface](./inference.md).

## Panel concepts

**Namespace**
A grouping label on model configs, used to sort models by purpose or source. It's a separate matter from which disk directory a file actually sits in: renaming a namespace only changes the label and never touches any file, and the same GGUF file can be referenced by multiple model configs across different namespaces at the same time. See [Files & Namespaces](./files.md).

**Repo profile**
A record registered when downloading from Hugging Face, corresponding to a fixed directory on disk that keeps that repo's quantization list and each item's local download status. Its purpose is so that when you come back later to download another quant from the same repo, the panel already knows what you have. See [Files & Namespaces](./files.md).

**Model config**
A model record in the panel, containing the model name, the GGUF file it points to, and that model's own inference parameters. It's a separate thing from the file on disk — deleting a model config doesn't delete the file. See [Model Management](./models.md).

**Overrides and effective parameters**
Each model's inference parameters = the global default config with that model's own overrides layered on top. An override only records what differs from the default; everything else follows the default as it changes. The merged result of the two is called the "effective parameters" — the ones actually assembled into the command line at startup, previewable on the edit page. See [Model Management](./models.md).

**Host-viewpoint paths**
Absolute paths in the panel's config (things like the model library location and mount mappings) are written using the host's directory structure, not the path as seen from inside the panel's own container — because mounting a directory into a model container when it starts only understands host paths. A model's own GGUF path is a separate matter — that's a path relative to the model library root. See [Deployment & Operations](./deployment.md).

## Runtime & resources

**Ready**
A container being up doesn't mean the model can accept requests yet — loading the weights takes time, and on a large model this can take tens of seconds. The panel keeps probing until the service actually starts responding, and only then does it count as ready. An inference request sent during the startup window gets a 502. See [Inference Interface](./inference.md).

**VRAM**
The memory on the GPU, used by both the model weights and the context cache. Running out of VRAM is the most common reason a start fails. The panel gives you a hint based on this model's past runs, but doesn't block starting — too many factors affect actual usage to give a precise prediction. See [Troubleshooting](./troubleshooting.md).

**Context length**
The maximum number of tokens a model can process in one go, including the conversation history and this response. Turning it up lets it remember longer conversations, at the cost of significantly more VRAM usage. See [Model Management](./models.md).

**KV Cache**
Intermediate results cached during inference, to avoid recomputing content that's already been generated. It grows as the conversation gets longer, which is why context length directly affects VRAM usage. You can watch its live usage on the monitoring page. See [Monitoring & Logs](./monitoring.md).

**Slot**
A position llama-server uses to process requests in parallel; the count determines how many conversations it can serve at once. When all slots are occupied, later requests queue up. The monitoring page's "Active slots" shows the current count in use. See [Monitoring & Logs](./monitoring.md).
