# 快速开始

## 前提条件

| 项 | 要求 | 说明 |
| --- | --- | --- |
| Docker | 较新版本的 Docker Engine，含 Compose v2 插件（`docker compose`，不是旧版 `docker-compose`） | 面板以容器方式运行，挂载 `docker.sock` 管理平级的 llama.cpp 容器 |
| GPU 加速 | NVIDIA Container Toolkit | 面板容器要叠加 `docker-compose.gpu.yml`（`.env` 的 `COMPOSE_FILE` 控制）才能读到 `nvidia-smi`，装了才有 GPU 监控；用部署管理脚本安装时向导会问，之后可用 `llamapad config` 切换。**纯 CPU 部署**：`COMPOSE_FILE=docker-compose.yml` 即可，不需要删任何行 |
| 磁盘 | 视模型而定 | GGUF 动辄数十 GB，建议给 `models/` 单独挂一块盘 |

## 部署三步

1. 在 Linux 服务器上执行 `curl -fsSL https://raw.githubusercontent.com/LanceLRQ/llamapad/main/deploy/llamapad.sh | bash`
2. 按向导回答：模型库位置、运行身份、GPU、端口、管理员密码（留空随机生成，结束时显示一次）
3. 选择「现在启动」，浏览器打开结束页给出的地址

手工部署 compose、网络受限环境与接管旧部署，见[部署与运维](./deployment.md)。

## 首次登录

浏览器打开 `http://<服务器地址>:28960`（宿主端口可在 `.env` 用 `PANEL_PORT` 覆盖，容器内固定 28960），用 `.env` 里的 `PANEL_ADMIN_PASSWORD` 登录。

这个密码就是管理员密码的唯一来源：要改密码就改 `.env` 里的值再重启容器（用部署管理脚本则是 `llamapad config`），面板启动时发现变化会更新密码，并让所有已登录的浏览器重新登录。

## 启动第一个模型

面板本身不带任何模型，两条路径任选：

- **在线拉取**：进「下载」页新建下载，填一个 Hugging Face 仓库 ID，面板会按量化（Q4_K_M / Q8_0 …）自动分组，选一组下载即可
- **已有文件**：把 GGUF 直接放进 `models/` 目录，面板会在文件页扫到它

> GGUF、量化、分片、mmproj 这些名词的含义见[术语表](./glossary.md)。

文件就位后，去「模型」页新建配置（或从文件页直接「创建配置」），保存后点「启动」。

## 运行中 ≠ 已经能推理

点「启动」后面板会先创建容器，再另外探测 llama-server 是否已经开始监听端口——**容器起来和模型能推理是两件事**。大模型要把权重读进显存、初始化 CUDA，这个过程可能持续几秒到几十秒；实测一个 27B 模型，从容器起来到真正监听端口之间有约 35 秒的窗口。

这段窗口期内面板列表会显示「运行中」，但此时发请求会失败（面板自建的 Playground 对此有加载态，会一直显示「模型加载中」直到探测到就绪；用脚本直连 API 的需要自己做重试，不要一看到容器状态是运行中就认为可以发请求了）。

## 下一步

- 完整部署步骤（目录布局、运行身份与权限、构建代理、升级备份）见[部署与运维](./deployment.md)
- 要把面板放到 HTTPS 域名之后访问，见[HTTPS 反代](./nginx.md)
- 模型的启停、参数配置、思考强度见[模型管理](./models.md)
- 批量下载与下载源配置见[模型下载](./downloads.md)
- 目录结构与命名空间语义见[文件与命名空间](./files.md)
