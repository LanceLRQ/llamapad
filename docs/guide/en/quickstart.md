# Quick Start

## Prerequisites

| Item | Requirement | Notes |
| --- | --- | --- |
| Docker | A reasonably recent Docker Engine with the Compose v2 plugin (`docker compose`, not the legacy `docker-compose`) | The panel runs as a container and manages sibling llama.cpp containers by mounting `docker.sock` |
| GPU acceleration | NVIDIA Container Toolkit | The panel container needs `docker-compose.gpu.yml` layered in (controlled by `.env`'s `COMPOSE_FILE`) to read `nvidia-smi`, which is what GPU monitoring depends on; the deployment script's install wizard asks about this, and `llamapad config` can toggle it afterwards. **CPU-only deployment**: just set `COMPOSE_FILE=docker-compose.yml`, no line to delete |
| Disk | Depends on your models | GGUF files routinely run to tens of GB, so give `models/` its own disk if you can |

## Deploy in three steps

1. On a Linux server, run `curl -fsSL https://raw.githubusercontent.com/LanceLRQ/llamapad/main/deploy/llamapad.sh | bash`
2. Answer the wizard: model library location, runtime identity, GPU, port, admin password (leave empty to generate one; it is shown once at the end)
3. Choose to start now, then open the address shown on the final screen

For manual Compose deployment, restricted networks and adopting an existing deployment, see [Deployment & Operations](./deployment.md).

## First sign-in

Open `http://<server-address>:28960` in a browser (the host port can be overridden with `PANEL_PORT` in `.env`; it's fixed at 28960 inside the container), and sign in with the `PANEL_ADMIN_PASSWORD` from `.env`.

This password is the single source of truth for the admin password: to change it, change the value in `.env` and restart the container (or use `llamapad config` with the deployment script). When the panel starts and sees a different value, it updates the password and signs every logged-in browser out.

## Starting your first model

The panel doesn't ship with any models. Pick either path:

- **Pull one online**: go to the Downloads page, start a new download, and enter a Hugging Face repo ID; the panel groups the files by quantization (Q4_K_M / Q8_0 / …) automatically, and you just pick a group to download
- **Use files you already have**: drop GGUF files straight into the `models/` directory, and the panel will find them on the Files page

> For what GGUF, quantization, shards and mmproj mean, see the [Glossary](./glossary.md).

Once the file is in place, go to the Models page and create a new config (or click "Create config" directly from the Files page), save it, and click "Start".

## "Running" is not the same as "ready to serve"

Clicking "Start" makes the panel create the container first, then separately probe whether llama-server has actually started listening on its port. **The container coming up and the model being able to serve requests are two different things.** Loading weights into VRAM and initializing CUDA for a large model can take anywhere from a few seconds to tens of seconds; in practice, a 27B model showed roughly a 35-second window between the container coming up and the port actually accepting connections.

During that window, the model list will show "Running", but requests sent during this time will fail (the panel's built-in Playground has a loading state for exactly this case, showing "Loading model" until it detects readiness; if you're hitting the API directly from a script, you need to handle retries yourself; don't assume a container that shows as running can already accept requests).

## Next steps

- Full deployment steps (directory layout, runtime identity and permissions, build proxy, upgrades and backups): [Deployment & Operations](./deployment.md)
- Putting the panel behind an HTTPS domain: [HTTPS Reverse Proxy](./nginx.md)
- Starting/stopping models, parameter config, reasoning effort: [Model Management](./models.md)
- Batch downloads and download-source configuration: [Model Downloads](./downloads.md)
- Directory layout and namespace semantics: [Files & Namespaces](./files.md)
