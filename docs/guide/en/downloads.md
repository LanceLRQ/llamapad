# Model Downloads

## Three sources

Starting a new download from the Downloads page has two entry points:

- **HF repo**: enter a Hugging Face repo ID (`owner/repo`); the panel registers a "repo profile" and reads the remote file list, groups it by quantization automatically, and you pick one group (or several) and submit to queue them for download
- **Direct URL**: enter an http/https link directly — this doesn't go through the repo-profile layer, and the filename on disk defaults to the last segment of the link (you can also specify it manually)

Repo profiles and direct URLs are two independent paths: a direct URL is better suited to downloading a single file or something from a non-Hugging-Face source; the value of a repo profile is that it records the whole repo's quant list and local download status (not downloaded / partial shards / downloaded / file located elsewhere), making it easy to come back later and pick another quant from the same repo — profile management is covered in [Files & Namespaces](./files.md).

## Automatic grouping: quantization, shards, mmproj

When a repo profile page shows the remote file list, the panel groups it automatically using the rules below, rather than laying out dozens of GGUF files flat:

- Quantization labels are detected from filenames (`Q4_K_M`, `Q8_0`, `IQ4_XS`, `BF16`, etc.); different quants each form their own group and are never mixed together
- Files with shard naming like `-00001-of-00005.gguf` — same prefix, same declared total — are automatically merged into one group: selecting any one shard pulls in the whole group, because a sharded model's GGUF reference is a glob, not a single path, and a model with only half its shards downloaded won't start
- Files whose name starts with `mmproj` are identified as multimodal projector files and always form their own group, even if they share a name with some quantization group — they're never mixed in with the model body
- Only files with a `.gguf` extension participate in grouping; `safetensors` / `.bin` / `README` and similar files in the repo are always skipped and not shown

## Resumable transfers and sha256 verification

Downloads support HTTP Range resuming: a task that was paused, hit a network interruption, or is resumed after a panel restart continues from the end of the existing `.part` temp file instead of downloading the whole thing again.

sha256 verification only happens when **an expected hash value is available**: for files downloaded from an HF repo, if the LFS metadata carries an oid, the panel computes the actual hash as it downloads and compares it against the expected value once the download completes; direct URL downloads usually have no comparable hash source, so verification is skipped. When a comparison fails, the task is marked failed, with the error message showing both the expected and actual values — you need to retry manually (it doesn't auto-retry).

## The difference between Pause / Resume / Cancel / Retry

These four actions look similar but have different semantics:

| Action | Effect | `.part` temp file |
| --- | --- | --- |
| Pause | Interrupts the current transfer; the queue stops at this task | Kept, so Resume can continue from it |
| Resume | Resumes a paused task | Continues via Range |
| Cancel | Abandons this task entirely | Deleted |
| Retry | Puts a "failed" or "cancelled" task back into the queue in place | Resumes from it if it exists, otherwise starts from scratch |

Retry is only available for failed or cancelled tasks — retrying a completed task doesn't make sense (to re-download, queue it again), and a paused task should use "Resume" rather than "Retry" — a mismatched state gets a 409 from the API.

The download queue itself runs single-threaded, sequentially: only one task runs at a time, and the next one starts automatically once the current one finishes (or is skipped). After 3 consecutive failures the queue stops itself and doesn't automatically move on. An occasional single-file 404 or hash mismatch shouldn't take down the whole batch, so the queue keeps going after a failure below that threshold; but 3 consecutive failures is likely a systemic issue like a dropped connection or a full disk, and there's no point spinning further. The panel stops the queue and shows a notice at the top of the Downloads page — you need to deal with the failed tasks and click "Resume queue" manually to get it going again. Newly queued tasks only get added to the queue; they don't wake up a stopped queue on their own, which avoids a situation where, after one stop, every new task can only squeeze in one at a time.

## Token, mirror and proxy configuration

All three live under "Settings → Model library → Download source":

- **Access token**: the `HF_TOKEN` environment variable takes precedence over a token saved in the panel. When this env var is set, the panel's token input becomes read-only display; to switch to using a panel-saved token, you need to first unset the environment variable and restart the container
- **Mirror**: choose one of official (`huggingface.co`), a built-in mainland-China mirror (`hf-mirror.com`), or a custom URL
- **Outbound proxy**: a proxy saved in the panel settings overrides the one configured in `panel.yaml`, and takes effect immediately on save with no restart needed. `panel.yaml` itself is never rewritten by the panel, so you can still edit it by hand for diagnostics even if the panel won't start. A proxy address that includes a username and password is automatically masked to `***` when displayed, and is never shown back in plaintext

After saving Token / Mirror / Proxy, the Settings page has a "Test connection" button that sends a real request to Hugging Face's whoami endpoint using the currently effective combination of settings, to verify connectivity and token validity (with no token configured, it only verifies anonymous connectivity) — it's worth testing once after changing config, rather than discovering a connectivity problem halfway through a queued batch.

## Next steps

- Archive management and directory layout after a download completes: [Files & Namespaces](./files.md)
- Creating a model config: [Model Management](./models.md)
