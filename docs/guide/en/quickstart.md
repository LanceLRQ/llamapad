# Quick Start

## Prerequisites

| Item | Requirement | Notes |
| --- | --- | --- |
| Docker | A reasonably recent Docker Engine with the Compose v2 plugin (`docker compose`, not the legacy `docker-compose`) | The panel runs as a container and manages sibling llama.cpp containers by mounting `docker.sock` |
| GPU acceleration | NVIDIA Container Toolkit | Skip this for CPU-only inference; the panel container needs `--gpus all` to read `nvidia-smi`, which is what GPU monitoring depends on |
| Disk | Depends on your models | GGUF files routinely run to tens of GB — give `models/` its own disk if you can |

## Three steps to deploy

1. Build the image from the repo root: `docker build -t llamapad:v0.1.0-rc .` (networks with restricted external access must pass proxy args, or you'll lose the dependency layer cache)
2. Prepare a self-contained deployment directory (`docker-compose.yml` + `data/` + `models/` side by side), and fill in a `.env` following `deploy/.env.example` — at minimum you need `PANEL_ADMIN_PASSWORD`
3. `docker compose up -d`

For the details behind each of these three steps — ownership alignment, the `docker.sock` gid, how to pass proxy args — see [Deployment & Operations](./deployment.md).

## First sign-in

Open `http://<server-address>:28960` in a browser (the host port can be overridden with `PANEL_PORT` in `.env`; it's fixed at 28960 inside the container), and sign in with the `PANEL_ADMIN_PASSWORD` from `.env`.

This password only takes effect while **the admin table is empty** — once you sign in successfully for the first time and the panel has created its admin record, `PANEL_ADMIN_PASSWORD` is no longer read. Changing the password from then on happens in "Settings → Account & data", not by editing `.env` and restarting.

## Starting your first model

The panel doesn't ship with any models. Pick either path:

- **Pull one online**: go to the Downloads page, start a new download, and enter a Hugging Face repo ID — the panel groups the files by quantization (Q4_K_M / Q8_0 / …) automatically, and you just pick a group to download
- **Use files you already have**: drop GGUF files straight into the `models/` directory, and the panel will find them on the Files page

> For what GGUF, quantization, shards and mmproj mean, see the [Glossary](./glossary.md).

Once the file is in place, go to the Models page and create a new config (or click "Create config" directly from the Files page), save it, and click "Start".

## "Running" is not the same as "ready to serve"

Clicking "Start" makes the panel create the container first, then separately probe whether llama-server has actually started listening on its port — **the container coming up and the model being able to serve requests are two different things**. Loading weights into VRAM and initializing CUDA for a large model can take anywhere from a few seconds to tens of seconds; in practice, a 27B model showed roughly a 35-second window between the container coming up and the port actually accepting connections.

During that window, the model list will show "Running", but requests sent during this time will fail (the panel's built-in Playground has a loading state for exactly this case, showing "Loading model" until it detects readiness; if you're hitting the API directly from a script, you need to handle retries yourself — don't assume a container that shows as running can already accept requests).

## Next steps

- Full deployment steps (directory layout, runtime identity and permissions, build proxy, upgrades and backups): [Deployment & Operations](./deployment.md)
- Putting the panel behind an HTTPS domain: [HTTPS Reverse Proxy](./nginx.md)
- Starting/stopping models, parameter config, reasoning effort: [Model Management](./models.md)
- Batch downloads and download-source configuration: [Model Downloads](./downloads.md)
- Directory layout and namespace semantics: [Files & Namespaces](./files.md)
