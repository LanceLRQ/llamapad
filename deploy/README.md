# llamapad 部署

> GPU 服务器上的部署模板与说明。镜像：本地构建 `llamapad:v0.1.0-rc`（不发布远端仓库）。

```bash
# 在仓库根目录构建镜像（首次或代码更新后）
docker build -t llamapad:v0.1.0-rc .
```

## 目录布局

| 路径（宿主机） | 用途 |
|---|---|
| `/srv/llama/config/` | 面板数据卷：`panel.yaml`（基础设施配置）、`panel.db`（SQLite 真源）、`export/`（YAML 自动快照，可 git 化备份） |
| `/root/workspace/llama/models/` | GGUF 模型根目录（本机复用 llama-launcher 原目录；下载新模型也落此处） |

> models 目录通过 bind 挂载进面板容器 `/host-models`。`panel.yaml` 的 `paths.models.host` 必须写**宿主机视角**路径（供 llama.cpp 容器 bind），`paths.models.panel` 写面板容器内路径。

## 首次部署

```bash
# 1. 准备目录
mkdir -p /srv/llama/config

# 2. 写初始 panel.yaml（路径映射）
cat > /srv/llama/config/panel.yaml <<'EOF'
paths:
  models:
    host: /root/workspace/llama/models
    panel: /host-models
EOF

# 3. 确定面板的运行身份（见下方「运行身份与目录权限」）
stat -c '%u:%g' /root/workspace/llama/models   # 模型库属主，如 0:0

# 4. 首启密码与运行身份（.env 不入库）
cd deploy
cat > .env <<'ENV'
PANEL_ADMIN_PASSWORD=<你的管理员密码>
PUID=0
PGID=0
ENV

# 5. config 目录属主对齐 PUID/PGID，否则 SQLite 打不开（SQLITE_CANTOPEN）
chown -R 0:0 /srv/llama/config

# 6. 核对 docker.sock 的 gid 与 compose 中 group_add 一致
stat -c %g /var/run/docker.sock   # 本机为 984；不同机器改 compose

# 7. 起容器
docker compose up -d

# 8. 浏览器访问 http://<服务器>:3000 → 用 PANEL_ADMIN_PASSWORD 登录
```

## 说明

- **`PANEL_DOCKER=real` 必须显式设置**（默认 `mock` 是 Mac 开发模式）
- **`PANEL_LLAMA_HOST=host.docker.internal`**（+ `extra_hosts` host-gateway）：面板容器内 `127.0.0.1` 不通向兄弟容器发布在宿主机的端口，反代与推理指标采集都经此地址访问 llama-server
- **`gpus: all`**：面板容器内 `nvidia-smi` 依赖它；去掉后面板 GPU 监控自动降级隐藏
- 面板默认以非 root（node, uid 1000）运行；通过 `group_add` 获得 docker.sock 读权限
- llama.cpp 容器（面板创建的兄弟容器）的 GPU 参数由面板按模型配置传入


## 运行身份与目录权限

面板要往两个 bind 目录写：`/srv/llama/config`（SQLite 与 YAML 快照）和 models 根（下载的 GGUF）。**容器内的运行用户必须对这两个目录可写**，否则表现为登录 500（`SQLITE_CANTOPEN`）或下载失败（`EACCES: permission denied, mkdir`）。

compose 的 `user: "${PUID:-1000}:${PGID:-1000}"` 决定运行身份，在 `.env` 里配：

| 场景 | 配法 |
|---|---|
| 模型库属主是 root（多数从 root 手工下载的机器） | `PUID=0` `PGID=0`，并 `chown -R 0:0 /srv/llama/config` |
| 模型库属主是普通用户（如 1000） | 不设 PUID/PGID（默认 1000），`chown -R 1000:1000 /srv/llama/config` |
| 模型库属主是其他 uid（如 1002） | `PUID=1002` `PGID=1002`，并 `chown -R 1002:1002 /srv/llama/config` |

查属主：`stat -c '%u:%g' <models 目录>`。

选 PUID 对齐既有属主，而不是反过来 `chown` 模型库——模型库常有上百 GB，改属主慢且影响其他用途。config 目录是面板自己的数据卷，跟着 PUID 改属主没有副作用。

`group_add` 与 `user` 无关，始终需要（面板经 docker.sock 管理兄弟容器）；以 root 身份（PUID=0）运行时 sock 本就可读，该配置无害。

### 关于 PUID=0（以 root 运行）的安全权衡

镜像默认非 root（`USER node`），`PUID=0` 会让容器以 root 运行，看起来是降级。实际权衡要连着 docker.sock 一起看：

**挂载 docker.sock 本身就已等价于宿主 root 权限**——能访问 sock 就能创建特权容器、挂载宿主任意路径。这是 Portainer 式面板的固有前提，也是本项目管理兄弟容器的必要条件。相比之下，容器内进程是 uid 0 还是 1000 带来的增量风险有限。

尽管如此，仍建议按此优先级选择：

1. **模型库属主可控** → 用非 root（PUID 对齐该属主），保留纵深防御
2. **模型库是 root 属主且不便更改** → `PUID=0`，接受上述权衡
3. 任何情况下都**不要**加 `privileged: true` 或额外 `cap_add`——面板不需要，本项目也从不要求

把面板暴露到公网前，务必置于 HTTPS 反代之后并确认登录口令强度（会话 cookie 的 Secure 属性需配合 HTTPS，见后续版本）。

## 升级

```bash
cd /mnt/data/github/llamapad && git pull
docker build -t llamapad:v0.1.0-rc .
cd deploy && docker compose up -d   # 配置与模型数据在 /srv/llama/config，升级不丢失
```

## 备份

`/srv/llama/config/export/` 下的 YAML 快照随每次配置变更自动更新：

```bash
cd /srv/llama/config/export && git init   # 之后定期 git add -A && git commit
```

灾备恢复：清空 admins/库后用面板「导入」功能吃回快照 zip 或逐模型 YAML。
