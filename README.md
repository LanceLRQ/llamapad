# llamapad

> 自托管的 llama.cpp 模型管理面板：浏览器里完成模型的启停切换、参数配置、自动下载与监控。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

## 简介

llamapad 是一个以 Docker 容器方式部署的 Web 管理面板（Portainer 式），面向在 GPU 服务器上用 Docker 运行 llama.cpp 大模型（GGUF）的用户。它是在 llama-launcher（bash 脚本版模型管理器）经验基础上的全面重写：除保留模型启动/停止/切换、状态与日志查看等原有能力外，新增面板内参数配置编辑、模型自动下载、文件管理、容器与 GPU 监控，并内嵌 llama.cpp 自带的 Web 聊天页。

> 🚧 项目正在开发中，尚未发布首个可用版本。

## 特性

- 🎛️ Web 管理面板：模型列表、一键启动/停止/切换（Docker + GPU 加速）
- 📝 面板内表单编辑模型参数，展示合并后最终参数；配置支持 YAML 导入/导出与自动快照（可 git 化备份）
- 🗂️ 命名空间管理模型文件：自定义空间分组、跨空间共享 GGUF、按引用安全删除
- 📥 模型自动下载：HuggingFace（官方/镜像）+ URL 直链，断点续传、sha256 校验、代理可配；输入仓库自动按量化（Q4/Q8/…）识别分组，分片模型自动成组
- 🧙 新建模型向导：从仓库选文件到保存配置一步完成
- 📁 ComfyUI 式统一目录管理：文件浏览、删除、磁盘占用
- 📊 监控：容器 CPU/内存、llama.cpp 推理指标（slots/token 速率）、GPU 显存（nvidia-smi）、实时日志
- 💬 Playground：内嵌 llama.cpp 自带 Web UI（经面板反代，SSH 隧道场景只需暴露一个端口）
- 🔐 登录鉴权 + 文档化 REST API（脚本可直接调用）
- 🌏 中/英双语界面

## 部署

开发中，镜像尚未发布。目标形态：

```bash
docker run -d --name llamapad \
  -p 8080:8080 \
  --gpus all \   # 可选：启用 GPU 显存监控
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /srv/llama:/srv/llama \
  ghcr.io/lancelrq/llamapad:latest
```

前提条件：Docker（GPU 加速需 NVIDIA Container Runtime）。

## 文档

- 上手指南（编写中，将位于 `docs/getting-started.md`）

## 贡献

欢迎提交 Issue；PR 前建议先开 Issue 讨论。

## License

MIT — 详见 [LICENSE](./LICENSE)。
