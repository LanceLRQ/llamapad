# docker-llama-cli

> 用 TypeScript + Ink 构建的终端 TUI，管理 Docker 化运行的 llama.cpp 本地大模型服务。

## 项目一句话定义

一个本地大模型的「启动器 + 管理台」：在终端交互式 TUI 里完成 GGUF 模型的启动/停止/切换、参数配置编辑与模型自动下载。类比 Docker Compose 之于容器编排，本工具之于 llama.cpp 模型服务；不是通用模型网关，也不是推理框架本身（推理由 llama.cpp 官方 Docker 镜像完成）。

## 核心设计要点

- **TUI 优先**：用 Ink（React 渲染到终端）实现真正的交互式界面，替代前身 bash 脚本里 whiptail/dialog 的拼接方案；同时保留非交互子命令模式，便于脚本调用。
- **声明式 YAML 配置**：沿用前身验证过的 `default.yaml` + 模型级 overrides 分层合并模型参数，配置即文档。
- **Docker 单一运行时**：模型一律通过 llama.cpp 官方镜像以容器方式运行（NVIDIA GPU 加速），工具本身不管理裸机进程。
- **配置即改即用**：新增在 TUI 内直接编辑模型/默认配置参数的能力（改动写回 YAML 文件），不再要求用户手工编辑文件。
- **模型自动下载**：新增按模型配置自动下载 GGUF（及 mmproj）文件的能力，下载来源与断点续传策略在特性设计阶段定案。
- **单模型运行约束（延续）**：与前身一致，同一时刻只运行一个模型实例（固定容器名 + 端口），多实例支持留给后续演进。

## 技术栈

- **语言**：TypeScript（strict 模式）
- **TUI 框架**：Ink（React for CLI）
- **运行时**：Node.js ≥ 20
- **其他**：YAML 解析、Docker 操作、模型下载的具体库选型在技术选型阶段定案（过程记录见 `docs/_internal/discussion/`，结论回填此处）

## 实现现状

项目处于**初始化阶段**：

- ✅ 文档治理结构（公开/私有双轨）已建立
- ⬜ 需求分析与整体设计
- ⬜ M0 工程骨架（npm 工程化、构建、测试框架）
- ⬜ 核心功能：模型管理 / 配置编辑 / 模型下载

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

（`src/` 等代码目录在工程骨架建立后补充。）

## 常用命令

```bash
# 工程骨架尚未创建，命令待 npm 工程化后补充：
# npm install      # 安装依赖
# npm run build    # 构建
# npm test         # 测试
# npm start        # 运行 TUI
```
