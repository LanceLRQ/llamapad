# 部署与运维

> GPU 服务器上的部署模板与说明。镜像：本地构建 `llamapad:v0.1.0-rc`（不发布远端仓库）。
> 部署目录自包含：`docker-compose.yml` + `data/`（面板数据）+ `models/`（GGUF 库）三者同级，整体拷走即可换机。

```bash
# 在仓库根目录构建镜像（首次或代码更新后）
docker build -t llamapad:v0.1.0-rc .
# 外网受限的环境（国内服务器等）务必带上代理参数，见下方「构建代理」
```

## 目录布局

部署目录自包含：三样东西同级，compose 里全用相对路径挂载，整个目录拷到别的机器即可运行。

| 路径（相对 `docker-compose.yml`） | 容器内 | 用途 |
|---|---|---|
| `.env` | — | 本机参数：首启密码、PUID/PGID、可选 PANEL_PORT（不入库） |
| `data/` | `/app/config` | 面板数据卷：`panel.db`（模型配置与账号，备份主要就是备份它）、`export/`（YAML 自动快照，可 git 化备份）、`logs/`（日志落盘）、可选的 `panel.yaml` |
| `models/` | `/host-models` | GGUF 模型根目录（下载的新模型也落此处） |

> **models 的宿主机绝对路径不用配**：llama.cpp 兄弟容器 bind 时需要宿主机视角路径，面板经
> docker.sock 查自己容器的挂载表自动认出 `./models` 对应的宿主机路径。优先级
> `PANEL_MODELS_HOST` 环境变量 > `panel.yaml` 的 `paths.models.host` > 自动发现。
>
> `panel.yaml` 因此**是可选的**：文件不存在时全部取默认值（models 容器内路径 `/host-models`）。
> 仍需要它的场景只有三个可选字段——`proxy`（面板出站代理）、`chat.base_url`、`listen`。

## 首次部署

```bash
# 1. 建部署目录（本例 /srv/llamapad，换成你自己的位置即可），放好 compose
mkdir -p /srv/llamapad/data
cd /srv/llamapad
cp /path/to/repo/deploy/docker-compose.yml .

# 2. 模型库：软链既有目录，或直接新建（下载的新模型也落这里）
ln -s /your/existing/gguf/library models   # 或 mkdir -p models

# 3. 确定面板的运行身份（见下方「运行身份与目录权限」）
stat -c '%u:%g' models/   # 模型库属主，如 0:0

# 4. 首启密码与运行身份（.env 不入库）
cat > .env <<'ENV'
PANEL_ADMIN_PASSWORD=<你的管理员密码>
PUID=0
PGID=0
ENV

# 5. data 目录属主对齐 PUID/PGID，否则 SQLite 打不开（SQLITE_CANTOPEN）
chown -R 0:0 data

# 6. 核对 docker.sock 的 gid 与 compose 中 group_add 一致
stat -c %g /var/run/docker.sock   # 本机为 984；不同机器改 compose

# 7. 起容器
docker compose up -d

# 8. 浏览器访问 http://<服务器>:28960 → 用 PANEL_ADMIN_PASSWORD 登录
#    （端口可在 .env 设 PANEL_PORT 覆盖，容器内固定 28960）
```

> **页头「打开 llama UI」外链**：`chat.base_url` 局域网直接访问（`http://IP:28960`）时留空即可，
> 面板按浏览器地址自动推导 `http://<hostname>:<host_port>`。Chat 页本身不依赖这个字段——它走
> 面板自己的同源反代，单域名、HTTPS 均可直接用；这个字段只影响页头那个新开标签打开 llama.cpp
> 自带 web UI 的外链按钮，仅当该按钮目标域启用了 HSTS、浏览器把明文地址强升为 https 导致连接
> 失败时，才需要在 `data/panel.yaml` 里显式指定一个可达地址，示例配置见[「HTTPS 反代」](./nginx.md)。

## 说明

- **`PANEL_DOCKER=real` 必须显式设置**（默认 `mock` 是 Mac 开发模式）
- **`PANEL_LLAMA_HOST=host.docker.internal`**（+ `extra_hosts` host-gateway）：面板容器内 `127.0.0.1` 不通向兄弟容器发布在宿主机的端口，反代与推理指标采集都经此地址访问 llama-server
- **`gpus: all`**：面板容器内 `nvidia-smi` 依赖它；去掉后面板 GPU 监控自动降级隐藏
- 面板默认以非 root（node, uid 1000）运行；通过 `group_add` 获得 docker.sock 读权限
- llama.cpp 容器（面板创建的兄弟容器）的 GPU 参数由面板按模型配置传入


## 运行身份与目录权限

面板要往两个 bind 目录写：`data/`（SQLite 与 YAML 快照）和 `models/`（下载的 GGUF）。**容器内的运行用户必须对这两个目录可写**，否则表现为登录 500（`SQLITE_CANTOPEN`）或下载失败（`EACCES: permission denied, mkdir`）。

compose 的 `user: "${PUID:-1000}:${PGID:-1000}"` 决定运行身份，在 `.env` 里配：

| 场景 | 配法 |
|---|---|
| 模型库属主是 root（多数从 root 手工下载的机器） | `PUID=0` `PGID=0`，并 `chown -R 0:0 data` |
| 模型库属主是普通用户（如 1000） | 不设 PUID/PGID（默认 1000），`chown -R 1000:1000 data` |
| 模型库属主是其他 uid（如 1002） | `PUID=1002` `PGID=1002`，并 `chown -R 1002:1002 data` |

查属主：`stat -c '%u:%g' <models 目录>`。

选 PUID 对齐既有属主，而不是反过来 `chown` 模型库——模型库常有上百 GB，改属主慢且影响其他用途。`data/` 是面板自己的数据卷，跟着 PUID 改属主没有副作用。

`group_add` 与 `user` 无关，始终需要（面板经 docker.sock 管理兄弟容器）；以 root 身份（PUID=0）运行时 sock 本就可读，该配置无害。

### 关于 PUID=0（以 root 运行）的安全权衡

镜像默认非 root（`USER node`），`PUID=0` 会让容器以 root 运行，看起来是降级。实际权衡要连着 docker.sock 一起看：

**挂载 docker.sock 本身就已等价于宿主 root 权限**——能访问 sock 就能创建特权容器、挂载宿主任意路径。这是 Portainer 式面板的固有前提，也是本项目管理兄弟容器的必要条件。相比之下，容器内进程是 uid 0 还是 1000 带来的增量风险有限。

尽管如此，仍建议按此优先级选择：

1. **模型库属主可控** → 用非 root（PUID 对齐该属主），保留纵深防御
2. **模型库是 root 属主且不便更改** → `PUID=0`，接受上述权衡
3. 任何情况下都**不要**加 `privileged: true` 或额外 `cap_add`——面板不需要，本项目也从不要求

把面板暴露到公网前，务必置于 HTTPS 反代之后并确认登录口令强度。面板会读 `X-Forwarded-Proto`
自动判断当前是否 HTTPS，并据此决定会话 cookie 是否加 `Secure`——反代配置见[「HTTPS 反代」](./nginx.md)。

## 升级

```bash
cd /path/to/repo && git pull                # 拉取最新代码
docker build -t llamapad:v0.1.0-rc .        # 外网受限记得带代理参数，见下方「构建代理」
cd /srv/llamapad && docker compose up -d    # 面板数据与模型在 data/ 与 models/，升级不丢失
```

> **宿主机网络指标需要重建容器**：compose 里的 `/proc:/host/proc:ro` 挂载
> （网络收发速率两项与磁盘读写 IO 两项共四个指标依赖它；宿主机 CPU、内存、
> 负载、磁盘剩余不受影响，无此挂载也能采集）。挂载是 `docker compose up -d` 会自动应用的容器
> 级配置，`docker compose restart` 不会生效——从旧版升级上来时先确认 compose
> 文件已同步这行，再执行上面的 `docker compose up -d`（它会按需重建容器，
> 不是单纯重启进程）。若暂不方便挂载 `/proc`，跳过这行即可，面板会静默降级为
> 不显示网络吞吐与磁盘 IO，其余宿主机指标正常。

## 备份

`data/export/` 下的 YAML 快照随每次配置变更自动更新：

```bash
cd /srv/llamapad/data/export && git init   # 之后定期 git add -A && git commit
```

灾备恢复：清空 admins/库后用面板「导入」功能吃回快照 zip 或逐模型 YAML。

---

## 构建代理

外网受限的环境下 `docker build` 会卡在 `apt-get`（实测直连 deb.debian.org 拉 9.7MB 的
`cpp-12` 包 60 秒都下不完）。传 Docker 的**预定义 build args** 即可，Dockerfile 无需改动
——BuildKit 会把它们注入所有构建阶段的 RUN 环境：

```bash
docker build \
  --build-arg HTTP_PROXY=http://<代理地址>:<端口> \
  --build-arg HTTPS_PROXY=http://<代理地址>:<端口> \
  --build-arg http_proxy=http://<代理地址>:<端口> \
  --build-arg https_proxy=http://<代理地址>:<端口> \
  --build-arg NO_PROXY=localhost,127.0.0.1 \
  -t llamapad:v0.1.0-rc .
```

代理地址要用**构建容器能到达的地址**：容器在 bridge 网络里，`127.0.0.1` 指向容器自己，
必须写宿主机的局域网 IP 或网关地址。不确定是否可达时先验一次：

```bash
docker run --rm node:22-bookworm-slim node -e '
require("http").request({host:"<代理地址>",port:<端口>,path:"http://deb.debian.org/debian/dists/bookworm/Release",
headers:{Host:"deb.debian.org"}},r=>console.log("HTTP",r.statusCode)).end()'
```

**代理参数不是可选的性能优化，每次构建都要带上。** 代理地址是依赖层缓存的一部分：上次
带代理构建、这次不带（或换了地址），`apt-get` 与 `pnpm install` 两层缓存会全部失效重跑。
同一份代码实测，带代理 17 秒构建完，不带代理跑满 10 分钟仍卡在 `apt-get`。
