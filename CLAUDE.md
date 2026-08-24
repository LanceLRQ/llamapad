# llamapad

> 自托管的 llama.cpp 模型管理面板：以 Docker 容器运行，管理 GGUF 模型的启停切换、参数配置、自动下载与监控。

## 项目一句话定义

一个本地大模型的「启动器 + 管理台」：Portainer 式部署的 Web 面板，通过挂载 docker.sock 管理 llama.cpp 兄弟容器，在浏览器里完成 GGUF 模型的启动/停止/切换、参数配置编辑、模型自动下载、文件管理、监控与日志。不是推理网关，不是多实例编排器，推理由 llama.cpp 官方镜像完成。

## 核心设计要点

- **Web 面板、自身容器化**：Next.js 单进程（API + 前端）打包为 Docker 镜像，挂载 docker.sock 创建/管理平级的 llama.cpp 容器（兄弟容器模式）
- **SQLite 配置真源 + YAML 导入导出**：业务配置（模型/命名空间/默认参数）存 SQLite（panel.db），bash 版 YAML 可直接导入；每次变更自动导出 YAML 快照（可 git 化作备份）；基础设施配置（路径映射/代理）保留 `panel.yaml` 文件
- **路径宿主机视角**：所有配置路径以宿主机视角书写（Docker bind 需要），面板经 `panel.yaml` 映射表换算访问
- **自研下载器**：HF（官方 + 镜像）/ URL 直链，断点续传、sha256 校验、代理可配；向导内输入 repo 自动按量化识别分组（分片成组、mmproj 识别、无 GGUF 提示）
- **单模型运行**：同一时刻只运行一个模型（固定容器名 + Docker label），容器名/端口按模型可覆盖留口子
- **GPU 配置驱动**：镜像与 GPU 参数全部可配不硬编码；显存监控经面板容器 `--gpus all` 注入的 nvidia-smi

## 技术栈

- **框架**：Next.js（App Router，standalone 输出）
- **UI**：shadcn/ui + Tailwind CSS + Lucide 图标，next-intl 双语（中/英）
- **后端**：route handlers（REST + SSE）、dockerode、better-sqlite3、zod、`yaml`、undici（代理）
- **工具链**：Vitest + Testing Library，Docker 多阶段构建发布 ghcr.io/lancelrq/llamapad

## 实现现状

项目处于**设计定稿、待实施**阶段：

- ✅ 需求分析与整体设计（2026-08-24，见私有文档）
- ⬜ M0 工程骨架 → M1 模型管理 → M2 下载+向导 → M3 监控+Playground（Mac 可开发）
- ⬜ M4 真机联调 → M5 打磨发布（GPU 服务器）

进度看板：`docs/_internal/TASKS.md`（私有，不入库）。

## 仓库结构

```
.
├── CLAUDE.md                # 公开：项目定义与常用命令（本文件）
├── README.md                # 面向使用者的项目介绍
├── LICENSE                  # MIT
└── docs/
    ├── superpowers/specs/   # 定稿后可公开的设计规格
    └── _internal/           # 私有：设计过程文档（不入 git）
```

（`src/` 等代码目录在 M0 骨架建立后补充。）

## 常用命令

```bash
# 工程骨架尚未创建，命令待 M0 建立后补充：
# npm install      # 安装依赖
# npm run dev      # 开发（Mock Docker 适配器，Mac 可跑）
# npm test         # 测试
# npm run build    # 构建
```
