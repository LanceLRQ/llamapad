# llamapad

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg?style=flat-square)](./LICENSE)
[![Docker Pulls](https://img.shields.io/docker/pulls/lancelrq/llamapad?style=flat-square&logo=docker)](https://hub.docker.com/r/lancelrq/llamapad)
[![Docker Image Size](https://img.shields.io/docker/image-size/lancelrq/llamapad/latest?style=flat-square&logo=docker)](https://hub.docker.com/r/lancelrq/llamapad)
[![Docker Build](https://img.shields.io/github/actions/workflow/status/LanceLRQ/llamapad/docker-publish.yml?style=flat-square&logo=githubactions&logoColor=white&label=Docker%20Build)](https://github.com/LanceLRQ/llamapad/actions/workflows/docker-publish.yml)
[![Powered by llama.cpp](https://img.shields.io/badge/Powered%20by-llama.cpp-06aead?style=flat-square)](https://github.com/ggml-org/llama.cpp)

[中文](README_zh.md) | **English**

llamapad is a self-hosted management panel for llama.cpp. It manages a Dockerized llama.cpp service and model files in the browser.

## Features

- 🎛️ **Model management** - Model list with one-click start/stop/switch (Docker + GPU acceleration); only one model runs at a time
- 📝 **Parameter editing** - Form-based editing in the panel, showing the merged final parameters; configs support YAML import/export and automatic snapshots you can commit to git
- 🗂️ **Namespaces** - Group models into custom spaces, share GGUF files across spaces, delete safely with reference checks
- 📥 **Model downloads** - HuggingFace (official and mirror) plus direct URLs, resumable with sha256 verification, proxy configurable in the panel; pasting a repo auto-groups files by quantization (Q4/Q8/…), and split files are grouped automatically
- 🧙 **Creation wizard** - Pick a repo, choose files, save the config; done in one pass
- 📁 **File management** - ComfyUI-style unified file browser; move/rename with reference checks, disk usage at a glance
- 📊 **Monitoring** - Container CPU/memory, llama.cpp inference metrics (slots, token rates), GPU memory and temperature, host disk and network, live logs
- 💬 **Playground** - Built-in chat page; `/llama-proxy/*` also reverse-proxies the inference API, so an SSH tunnel only needs to expose one port
- 🔐 **Auth & API** - Login protection, plus a REST API you can call from scripts
- 🌏 **Bilingual UI** - Chinese/English interface with a built-in documentation center

## Quick Start

Install with one command (Linux + Docker required; NVIDIA Container Toolkit for GPU acceleration):

```bash
curl -fsSL https://raw.githubusercontent.com/LanceLRQ/llamapad/main/deploy/llamapad.sh | bash
```

The script checks your Docker setup, installs to `/opt/llamapad` by default, and walks you through picking a model directory (with free space listed per disk), a runtime user, GPU, port, and admin password (leave blank to generate one). It detects the `docker.sock` gid on its own, then pulls the image and starts the panel.

Once installed, run `llamapad` from any directory to open the management menu:

| Command | What it does |
|---|---|
| `llamapad` | Interactive arrow-key menu |
| `llamapad start` / `stop` / `restart` / `status` | Start, stop, restart, check status |
| `llamapad logs -f` | Follow logs |
| `llamapad config` | Change port, listen address, model directory, GPU, admin password, and more |
| `llamapad build [--repo path]` | Build the image locally (shows up in the menu as "Build image" when a repo is found) |
| `llamapad upgrade` | Upgrade the script and image |
| `llamapad doctor` | Environment self-check |
| `llamapad uninstall` | Uninstall |

If you'd rather deploy the compose file by hand, see [Deployment](./docs/guide/en/deployment.md). To take over an existing manual deployment, just run the script in that directory (back up first; your data and models are left untouched).

## Documentation

Full documentation lives in [`docs/guide/en/`](./docs/guide/en/) (also available in Chinese), and can be read inside the panel from the sidebar. No required reading order; look up what you need.

**Getting started**

| Document | Contents |
|---|---|
| [Quick Start](./docs/guide/en/quickstart.md) | Three steps to deploy, first login, launching your first model |
| [Glossary](./docs/guide/en/glossary.md) | Quick reference: GGUF, quantization, splits, namespaces, and other terms |

**Deployment**

| Document | Contents |
|---|---|
| [Deployment & Operations](./docs/guide/en/deployment.md) | Directory layout, runtime user and permissions, build-time proxy, upgrades and backups |
| [HTTPS Reverse Proxy](./docs/guide/en/nginx.md) | Reference nginx configs for single-domain and subdomain setups |

**Usage**

| Document | Contents |
|---|---|
| [Model Management](./docs/guide/en/models.md) | Create/edit/clone, parameter groups, single-model constraint, readiness checks |
| [Model Downloads](./docs/guide/en/downloads.md) | HF and direct links, resumable downloads, verification, proxy configuration |
| [Files & Namespaces](./docs/guide/en/files.md) | Directory structure, namespace semantics, reference checks, the three-layer deletion model |
| [Settings Reference](./docs/guide/en/settings.md) | All four settings groups, item by item |

**Operations & Troubleshooting**

| Document | Contents |
|---|---|
| [Monitoring & Logs](./docs/guide/en/monitoring.md) | Metric definitions, multi-GPU aggregation, retention tiers and source fallback |
| [Config Format & Migration](./docs/guide/en/config.md) | Fields of the exported YAML, hand editing, migrating from llama-launcher |
| [Troubleshooting](./docs/guide/en/troubleshooting.md) | Known pitfalls, each verified on a real machine |

**API**

| Document | Contents |
|---|---|
| [Inference API](./docs/guide/en/inference.md) | Playground, the proxy endpoint, clients and SDK integration |
| [Panel API](./docs/guide/en/api.md) | Authentication, common task examples, full endpoint list |

Chinese documentation: [`docs/guide/zh/`](./docs/guide/zh/).

## Development

```bash
pnpm install       # pnpm is the package manager
pnpm run dev       # dev server (PANEL_DOCKER defaults to mock; no real docker.sock needed)
pnpm test          # tests (vitest)
pnpm run lint      # eslint
pnpm run build     # production build (next build, standalone output)
```

## Contributing

Issues are welcome; please open one before sending a PR. When reporting a bug, attach the output of `llamapad doctor` if you can.

## License

MIT — see [LICENSE](./LICENSE).

---

If llamapad is useful to you, please consider giving it a ⭐ on [GitHub](https://github.com/LanceLRQ/llamapad) and [Docker Hub](https://hub.docker.com/r/lancelrq/llamapad).
