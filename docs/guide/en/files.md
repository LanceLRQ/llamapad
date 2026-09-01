# Files & Namespaces

## Directory layout

All model files sit flat under `models/<namespace>/` (a namespace can be a multi-level directory). **A namespace is a grouping label for model configs, and which directory a file actually sits in is a separate matter that doesn't imply the other.** A model's GGUF path is an independent relative path string, with no binding to the namespace field it belongs to — the same physical file can perfectly well be referenced by multiple model configs across different namespaces (for example, the same GGUF shared by two models with different parameter overrides).

This separation exists to avoid tying namespaces too tightly to physical files: changing a namespace only changes the label, never touches any file; moving a physical file is a separate operation on the Files page. The two are decoupled and don't affect each other — renaming a namespace never leaves a model unable to find its file, and moving a file never accidentally changes which namespace it belongs to.

## Namespaces

Namespaces are managed under "Settings → Model library → Namespaces" (there's also a "+ New namespace" shortcut at the top of the Models page for convenience). Creating one only registers the namespace record — the disk directory is only created once it's actually used.

- **Rename**: only changes this namespace's label and the grouping of the model configs under it, and never moves any disk files; blocked while a model in this namespace is running
- **Delete**: requires that this namespace has no model configs left (move or delete them first); files and directories on disk are unaffected — only the namespace record is deleted, and you'd go to the Files page to clean up files. The `main` namespace can be deleted too — it's just the default landing spot for imports: if it gets deleted and something is imported or created afterward, the panel recreates it automatically, so there's no risk of accidentally deleting something the system needs

Namespaces being decoupled from disk directories means the "folders" list you see on the left of the Files page and the "namespaces" list on the Models page / Settings page are two lists with different scopes: one is the real directory tree from scanning disk, the other is the namespace grouping configured in the panel. Their counts not matching up is normal — it doesn't mean either side is wrong.

## Reference checks when moving or renaming

The Files page scans "who references this file" for every file before letting you move or rename it — a reference means either a model config's path field exactly matches the file's path (even if the file no longer exists), or the config specifies a shard glob that, once expanded, matches this specific file. When you move or rename a referenced file, the panel rewrites every model config that references it (including other models sharing the same physical file, not just the one you're operating on) to point at the new path — you don't need to update each model by hand.

Shard groups are handled as a whole: selecting any one shard automatically brings the rest of the group along for the move or rename, and the sequence segment (things like `-00001-of-00005`) is reserved by the system and can't be edited manually — a sharded model's reference is a glob, and moving only half the shards would leave the glob matching an orphaned single shard at the new location, which fails to start.

If a systemic failure happens partway through moving a referenced file, you can end up in an intermediate state where "the file has already moved to its new location, but the configs referencing it haven't been updated yet." The panel doesn't automatically retry or roll back in this case — instead it tells you to go manually check the affected models on the Models page. This kind of failure is usually rooted in a deterministic validation error, so retrying wouldn't help; it needs to be handled by hand.

## Three layers of delete semantics

Deletion in the panel is split into three independent layers, each with its own entry point and scope of impact:

| Layer | Entry point | Impact |
| --- | --- | --- |
| Delete config | Model edit page's "Danger zone" | Only deletes this model's config record (including parameter overrides); the GGUF file stays on disk untouched |
| Delete file | Files page | Actually removes the physical file from disk; checks for referencing model configs first |
| Delete namespace | Settings page | Only deletes the namespace label record; requires that the namespace has no model configs left |

If deleting a file finds a config referencing it (and no model currently running is using this file), the panel refuses first and lists the references — you need to confirm "I understand these configs will lose their file reference after deletion (the models won't be able to start)" before it force-deletes. If a running model is actually using this file, deletion is refused no matter what (you can't pull a file out from under a running container) — you have to stop that model first.

## Repo profiles

Files downloaded from a Hugging Face repo are managed collectively as a "repo profile" (`models/repos`); each profile corresponds to a fixed directory on disk, with a hidden marker file tucked inside it. Even if this directory gets moved by hand somewhere else, the panel can still reclaim it during a scan using that marker file, so it never turns into orphaned data.

The profile detail page lists every quantization group in the repo and its local status (not downloaded / partial shards / downloaded / file actually located elsewhere), with a few common actions:

- **Relocate**: when a file isn't in its profile directory for some reason (e.g. it was moved by hand), move it back to where it belongs
- **Recreate directory**: when the profile directory has been manually deleted or moved but the registration is still there, recreate the directory
- **Change storage location**: move the whole profile directory somewhere else, taking every file in the profile along with it, and rewriting the references of any model configs involved
- **Batch create configs**: for quants that are already downloaded but have no model config referencing them yet, create model configs for all of them in bulk using the global defaults, then fine-tune parameters afterward on the Models page

Profile directories are managed as a whole from the profile page — going into one of these directories from the Files page shows a notice: directory structure (creating folders, renaming) can't be edited directly on the Files page, and you also can't rename an individual file inside a profile directory from the Files page (renaming would make the profile unable to recognize the file, which can trigger a duplicate re-download) — these operations belong on the profile page.

Deleting a profile gives two choices: delete only the registration (keeping the files on disk) or delete the files along with it — the delete UI clearly shows how much disk space a combined deletion will clear, and that it's unrecoverable.

## Disk usage

On the Files page, each folder in the left panel shows the space used and file count for that directory (including all its subdirectories); switching to a specific directory or "All files" shows the header stats bar with the current slice's file count, space used (GB), and how many of its files are in use by a running model.

"File metadata" is a record table independent of the physical file tree (one row per logical file entry, with a shard group counted as one row) — you can manually tag files with a quantization label and notes, or kick off a background hash computation for a file. That computation produces the file's full sha256, which can be used to verify file integrity or to help "Auto-locate" relink a file that's been moved elsewhere. If the physical file backing a row in this table is no longer on disk, it's marked as an "Orphaned" record, and you can bulk-clear these with "Clear orphaned records" on the page — this only affects the metadata record itself, and doesn't touch any model config.

## Next steps

- Configuring a model's GGUF / mmproj path: [Model Management](./models.md)
- Where files come from after a download completes: [Model Downloads](./downloads.md)
