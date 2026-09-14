<a id="top"></a>

**[English](#en)** | **[中文](#zh)**

---

<a id="en"></a>
## English

**llamapad** is a self-hosted, browser-based control panel for managing [llama.cpp](https://github.com/ggml-org/llama.cpp) GGUF models with Docker. It runs as its own container, mounts `docker.sock`, and manages sibling llama.cpp containers — it does not do inference itself.

**Features**

- Model management: list, one-click start/stop/switch (Docker + GPU acceleration); only one model runs at a time, start/stop are mutually exclusive
- Parameter configuration: in-panel form editing with a merged-config preview; YAML import/export with automatic snapshots
- Namespaces: custom grouping, cross-namespace GGUF sharing, reference-safe deletion
- Model downloads: Hugging Face (official/mirror) and direct URL, resumable downloads, sha256 verification, configurable proxy; repo files are auto-grouped by quantization and shards are detected automatically
- Setup wizard: pick a repo, pick files, save the config in one flow
- File manager: unified directory browsing, move/rename with reference checks, disk usage overview
- Monitoring: container CPU/memory, llama.cpp inference metrics (slots/token rate), GPU memory & temperature, host disk & network, live logs
- Built-in chat Playground, plus an inference reverse proxy for scripts/SDKs
- Login authentication + REST API
- Bilingual UI (Chinese/English) with an in-app documentation center

### Supported tags

| Tag | Notes |
|---|---|
| `0.1.0` | First published release |
| `latest` | Always points to the latest stable (non-prerelease) release |

Built from the [Dockerfile](https://github.com/LanceLRQ/llamapad/blob/main/Dockerfile) in this repository. `linux/amd64` only.

### Prerequisites

- Docker Engine with the Compose v2 plugin (`docker compose`)
- For GPU acceleration: NVIDIA Container Toolkit (CPU-only deployments must remove the `gpus: all` line from the compose file, or the container will fail to start)
- Port `28960` reachable (or remapped via `PANEL_PORT`)

### Quick start (Docker Compose)

```bash
mkdir -p /srv/llamapad && cd /srv/llamapad
mkdir -p data models
chown -R 1000:1000 data models  # match .env's PUID/PGID (default 1000; skip this if you set them to 0)

curl -fsSL -o docker-compose.yml https://raw.githubusercontent.com/LanceLRQ/llamapad/main/deploy/docker-compose.yml
curl -fsSL -o .env https://raw.githubusercontent.com/LanceLRQ/llamapad/main/deploy/.env.example
```

Edit `.env`: set `PANEL_ADMIN_PASSWORD`, and `DOCKER_GID` (`stat -c %g /var/run/docker.sock` — required, varies per machine). See the file's comments for `PUID`/`PGID` (non-root by default) and other optional settings.

```bash
docker compose up -d
```

Open `http://<host>:28960` and sign in with `PANEL_ADMIN_PASSWORD`.

### Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `PANEL_ADMIN_PASSWORD` | Yes | — | Initial admin password (only used while the admin table is empty) |
| `DOCKER_GID` | Yes | — | gid of `docker.sock`; get it with `stat -c %g /var/run/docker.sock` |
| `PUID` / `PGID` | No | `1000` | Container runtime identity; must match the owner of `models/` (root-owned libraries: set both to `0`) |
| `PANEL_PORT` | No | `28960` | Host port; the container always listens on `28960` |
| `TZ` | No | `Asia/Shanghai` | Container timezone |
| `PANEL_LLM_BASE_URL` / `PANEL_LLM_API_KEY` / `PANEL_LLM_MODEL` / `PANEL_LLM_EXTRA_BODY` | No | — | Optional OpenAI-compatible LLM used to parse recommended parameters out of a model's README |

### Volumes

| Host path | Container path | Purpose |
|---|---|---|
| `./data` | `/app/config` | Panel data: SQLite database, YAML export snapshots, logs |
| `./models` | `/host-models` | GGUF model library |
| `/var/run/docker.sock` | `/var/run/docker.sock` | Required — lets the panel manage sibling llama.cpp containers |
| `/proc` | `/host/proc` (read-only) | Optional — enables host network/disk-IO metrics |

### Security notice

Mounting `docker.sock` is equivalent to granting host root privileges — anyone who can reach the panel can create privileged containers or mount arbitrary host paths. Never expose this panel directly to the public internet; put it behind an HTTPS reverse proxy and use a strong admin password. See the [nginx reverse proxy guide](https://github.com/LanceLRQ/llamapad/blob/main/docs/guide/en/nginx.md).

### Documentation

- [Deployment & Operations](https://github.com/LanceLRQ/llamapad/blob/main/docs/guide/en/deployment.md)
- [Quick Start](https://github.com/LanceLRQ/llamapad/blob/main/docs/guide/en/quickstart.md)
- Chinese docs below, or browse [docs/guide/zh](https://github.com/LanceLRQ/llamapad/tree/main/docs/guide/zh)

[Back to top](#top) · [中文版](#zh)

---

<a id="zh"></a>
## 中文

**llamapad** 是一个自托管的浏览器管理面板，用 Docker 管理 [llama.cpp](https://github.com/ggml-org/llama.cpp) 的 GGUF 模型。面板自身以容器方式运行，挂载 `docker.sock` 管理平级的 llama.cpp 容器——自己不做推理。

**特性**

- 模型管理：列表、一键启动/停止/切换（Docker + GPU 加速）；同一时刻只运行一个模型，启停互斥
- 参数配置：面板内表单编辑，展示合并后的最终参数；支持 YAML 导入/导出与自动快照
- 命名空间：自定义空间分组、跨空间共享 GGUF、按引用安全删除
- 模型下载：HuggingFace（官方/镜像）+ URL 直链，断点续传、sha256 校验、代理可配；输入仓库自动按量化识别分组，分片模型自动成组
- 新建向导：选仓库、挑文件、保存配置一步完成
- 文件管理：统一目录浏览、移动/重命名带引用检查、磁盘占用一览
- 监控：容器 CPU/内存、llama.cpp 推理指标（slots/token 速率）、GPU 显存与温度、宿主机磁盘与网络、实时日志
- 面板自建对话 Playground，另提供推理接口反代（供脚本/SDK 使用）
- 登录鉴权 + REST API
- 中/英双语界面，面板内置文档中心

### 支持的标签

| 标签 | 说明 |
|---|---|
| `0.1.0` | 首个发布版本 |
| `latest` | 始终指向最新的正式版（不含预发布版本） |

镜像基于本仓库的 [Dockerfile](https://github.com/LanceLRQ/llamapad/blob/main/Dockerfile) 构建，仅提供 `linux/amd64`。

### 前置条件

- Docker Engine + Compose v2 插件（`docker compose`）
- GPU 加速需要 NVIDIA Container Toolkit（纯 CPU 部署必须删掉 compose 里的 `gpus: all` 这一行，否则容器起不来）
- 放行 `28960` 端口（或用 `PANEL_PORT` 改映射）

### 快速开始（Docker Compose）

```bash
mkdir -p /srv/llamapad && cd /srv/llamapad
mkdir -p data models
chown -R 1000:1000 data models  # 要与 .env 的 PUID/PGID 一致（默认 1000；改填 0 时跳过这行）

curl -fsSL -o docker-compose.yml https://raw.githubusercontent.com/LanceLRQ/llamapad/main/deploy/docker-compose.yml
curl -fsSL -o .env https://raw.githubusercontent.com/LanceLRQ/llamapad/main/deploy/.env.example
```

编辑 `.env`：填写 `PANEL_ADMIN_PASSWORD`，以及 `DOCKER_GID`（`stat -c %g /var/run/docker.sock`，必填、因机器而异）。`PUID`/`PGID`（默认非 root）等其他可选项见文件内注释。

```bash
docker compose up -d
```

浏览器访问 `http://<服务器>:28960`，用 `PANEL_ADMIN_PASSWORD` 登录。

### 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `PANEL_ADMIN_PASSWORD` | 是 | — | 管理员首启密码（仅在管理员表为空时生效） |
| `DOCKER_GID` | 是 | — | `docker.sock` 的 gid，`stat -c %g /var/run/docker.sock` 获取 |
| `PUID` / `PGID` | 否 | `1000` | 容器运行身份，需对齐 `models/` 属主（root 属主时两者都填 `0`） |
| `PANEL_PORT` | 否 | `28960` | 宿主机端口；容器内固定监听 `28960` |
| `TZ` | 否 | `Asia/Shanghai` | 容器时区 |
| `PANEL_LLM_BASE_URL` / `PANEL_LLM_API_KEY` / `PANEL_LLM_MODEL` / `PANEL_LLM_EXTRA_BODY` | 否 | — | 可选的 OpenAI 兼容 LLM，用于从模型 README 里解析推荐参数 |

### 挂载卷

| 宿主机路径 | 容器内路径 | 用途 |
|---|---|---|
| `./data` | `/app/config` | 面板数据：SQLite 数据库、YAML 导出快照、日志 |
| `./models` | `/host-models` | GGUF 模型库 |
| `/var/run/docker.sock` | `/var/run/docker.sock` | 必需——面板经此管理平级的 llama.cpp 容器 |
| `/proc` | `/host/proc`（只读） | 可选——启用宿主机网络/磁盘 IO 指标 |

### 安全提示

挂载 `docker.sock` 等价于赋予宿主机 root 权限——能访问面板的人就能创建特权容器、挂载宿主任意路径。**不要把面板直接暴露到公网**，务必放在 HTTPS 反代之后并使用强管理员密码。参见 [nginx 反代文档](https://github.com/LanceLRQ/llamapad/blob/main/docs/guide/zh/nginx.md)。

### 文档

- [部署与运维](https://github.com/LanceLRQ/llamapad/blob/main/docs/guide/zh/deployment.md)
- [快速开始](https://github.com/LanceLRQ/llamapad/blob/main/docs/guide/zh/quickstart.md)
- 英文文档见上方，或浏览 [docs/guide/en](https://github.com/LanceLRQ/llamapad/tree/main/docs/guide/en)

[回到顶部](#top) · [English version](#en)
