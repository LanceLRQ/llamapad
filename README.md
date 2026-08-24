# docker-llama-cli

> 在终端里管理 Docker 化的 llama.cpp 本地大模型：启动、切换、改配置、下模型，一个 TUI 全搞定。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

## 简介

docker-llama-cli 是一个基于 TypeScript + Ink 的终端交互式工具（TUI），面向在本机用 Docker 运行 llama.cpp 大模型（GGUF）的用户。它是在 llama-launcher（bash 脚本版模型管理器）经验基础上的全面重写：除保留模型启动/停止/切换、状态与日志查看等原有能力外，新增了在界面内直接修改模型参数配置、自动下载模型文件等功能。

> 🚧 项目正在开发中，尚未发布首个可用版本。

## 特性

- 🎛️ 交互式 TUI：方向键操作，无需记忆 docker 与 llama.cpp 参数
- 🚀 一键启动/停止/切换模型（Docker + NVIDIA GPU 加速）
- 📝 界面内编辑模型参数，配置即改即用（写回 YAML）
- 📥 模型自动下载（GGUF / mmproj）
- 📋 实时日志查看、运行状态展示
- ⌨️ 同时提供非交互子命令模式，便于脚本调用

## 安装

开发中，暂未发布 npm 包。当前可从源码运行：

```bash
git clone git@github.com:LanceLRQ/docker-llama-cli.git
cd docker-llama-cli
npm install
npm run build
npm start
```

前提条件：Docker（含 NVIDIA Container Runtime）、Node.js ≥ 20。

## 使用

```bash
docker-llama            # 进入交互式 TUI
docker-llama ls         # 列出可用模型
docker-llama start x    # 启动指定模型
docker-llama stop       # 停止当前模型
```

## 文档

- 上手指南（编写中，将位于 `docs/getting-started.md`）

## 贡献

欢迎提交 Issue；PR 前建议先开 Issue 讨论。

## License

MIT — 详见 [LICENSE](./LICENSE)。
