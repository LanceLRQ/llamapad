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

# 3. 首启密码（.env 不入库）
cd deploy
echo 'PANEL_ADMIN_PASSWORD=<你的管理员密码>' > .env

# 4. 核对 docker.sock 的 gid 与 compose 中 group_add 一致
stat -c %g /var/run/docker.sock   # 本机为 984；不同机器改 compose

# 5. 起容器
docker compose up -d

# 6. 浏览器访问 http://<服务器>:3000 → 用 PANEL_ADMIN_PASSWORD 登录
```

## 说明

- **`PANEL_DOCKER=real` 必须显式设置**（默认 `mock` 是 Mac 开发模式）
- **`gpus: all`**：面板容器内 `nvidia-smi` 依赖它；去掉后面板 GPU 监控自动降级隐藏
- 面板以非 root（node, uid 1000）运行；通过 `group_add` 获得 docker.sock 读权限
- llama.cpp 容器（面板创建的兄弟容器）的 GPU 参数由面板按模型配置传入

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
