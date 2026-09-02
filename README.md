# llamapad

> 自托管的 llama.cpp 模型管理面板：浏览器里完成模型的启停切换、参数配置、自动下载与监控。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

## 简介

llamapad 是一个以 Docker 容器方式部署的 Web 管理面板（Portainer 式），面向在 GPU 服务器上用 Docker 运行 llama.cpp 大模型（GGUF）的用户。它挂载 `docker.sock` 管理平级的 llama.cpp 容器，自己不做推理——推理由 llama.cpp 官方镜像完成。

它是在 llama-launcher（bash 脚本版模型管理器）经验基础上的全面重写：除保留模型启动/停止/切换、状态与日志查看等原有能力外，新增面板内参数配置编辑、模型自动下载、文件管理、容器与 GPU 监控，以及一个自建的对话 Playground。

> 🚧 项目正在开发中，尚未发布首个可用版本。

## 特性

- 🎛️ **模型管理**：模型列表、一键启动/停止/切换（Docker + GPU 加速）；同一时刻只运行一个模型，启停互斥
- 📝 **参数配置**：面板内表单编辑，展示合并后的最终参数；配置支持 YAML 导入/导出与自动快照（可 git 化备份）
- 🗂️ **命名空间**：自定义空间分组、跨空间共享 GGUF、按引用安全删除
- 📥 **模型下载**：HuggingFace（官方/镜像）+ URL 直链，断点续传、sha256 校验、代理面板内可配；输入仓库自动按量化（Q4/Q8/…）识别分组，分片模型自动成组
- 🧙 **新建向导**：从选仓库、挑文件到保存配置一步完成
- 📁 **文件管理**：ComfyUI 式统一目录浏览、移动/重命名带引用检查、磁盘占用一览
- 📊 **监控**：容器 CPU/内存、llama.cpp 推理指标（slots/token 速率）、GPU 显存与温度、宿主机磁盘与网络、实时日志
- 💬 **Playground**：面板自建对话页；`/api/v1/proxy/llama/*` 另提供推理接口反代（SSH 隧道场景只需暴露面板一个端口）
- 🔐 登录鉴权 + REST API（脚本可直接调用）
- 🌏 中/英双语界面，面板内置文档中心

## 快速部署

镜像本地构建、不发布远端仓库。部署目录自包含（`docker-compose.yml` + `data/` + `models/` 同级）：

```bash
docker build -t llamapad:v0.1.0-rc .   # 在仓库根目录
cd /srv/llamapad && docker compose up -d
```

浏览器访问 `http://<服务器>:28960`，用 `.env` 里的 `PANEL_ADMIN_PASSWORD` 登录。

前提条件：Docker（GPU 加速需 NVIDIA Container Runtime）。外网受限的环境下构建**必须带代理参数**，否则会丢依赖层缓存——详见[部署与运维](./docs/guide/zh/deployment.md)。

## 文档

完整文档在 [`docs/guide/`](./docs/guide/)（中英双语），面板内也可直接阅读（侧栏「文档」）。文档之间没有固定阅读顺序，按需查阅即可。

**入门**

| 篇目 | 内容 |
|---|---|
| [快速开始](./docs/guide/zh/quickstart.md) | 部署三步、首次登录、启动第一个模型 |
| [术语表](./docs/guide/zh/glossary.md) | GGUF、量化、分片、命名空间等名词速查 |

**部署**

| 篇目 | 内容 |
|---|---|
| [部署与运维](./docs/guide/zh/deployment.md) | 目录布局、运行身份与权限、构建代理、升级与备份 |
| [HTTPS 反代](./docs/guide/zh/nginx.md) | nginx 参考配置，单域名与子域名两种拓扑 |

**使用**

| 篇目 | 内容 |
|---|---|
| [模型管理](./docs/guide/zh/models.md) | 新建/编辑/克隆、参数分组、单模型约束、就绪判定 |
| [模型下载](./docs/guide/zh/downloads.md) | HF 与直链、断点续传、校验、代理配置 |
| [文件与命名空间](./docs/guide/zh/files.md) | 目录结构、命名空间语义、引用检查、删除三层语义 |
| [设置项详解](./docs/guide/zh/settings.md) | 四组设置逐项说明 |

**运维与排错**

| 篇目 | 内容 |
|---|---|
| [监控与日志](./docs/guide/zh/monitoring.md) | 指标口径、多卡聚合规则、三层保留与降源 |
| [配置格式与迁移](./docs/guide/zh/config.md) | 导出 YAML 的字段说明、手工编辑、从 llama-launcher 迁移 |
| [排错](./docs/guide/zh/troubleshooting.md) | 已知坑清单，均有真机案例 |

**接口**

| 篇目 | 内容 |
|---|---|
| [推理接口](./docs/guide/zh/inference.md) | Playground、中转接口、客户端与 SDK 接入 |
| [面板 API](./docs/guide/zh/api.md) | 鉴权、常用任务示例、完整端点清单 |

English documentation: [`docs/guide/en/`](./docs/guide/en/).

## 开发

```bash
pnpm install       # 包管理器是 pnpm
pnpm run dev       # 开发（PANEL_DOCKER 默认 mock，无需真实 docker.sock）
pnpm test          # 测试（vitest）
pnpm run lint      # eslint
pnpm run build     # 构建（next build，standalone 产物）
```

## 贡献

欢迎提交 Issue；PR 前建议先开 Issue 讨论。

## License

MIT — 详见 [LICENSE](./LICENSE)。
