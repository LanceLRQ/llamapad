# 部署管理脚本 llamapad.sh

> 参见 [部署与运维](./deployment.md)。本文详细说明 `deploy/llamapad.sh` 单文件脚本本身：安装方式、每个命令/菜单项做了什么、安装状态是怎么判定的、目录里都有什么文件、脚本内置的安全守卫，以及全部可覆盖的环境变量。

## 概述

`llamapad.sh` 是一个单文件 bash 脚本（bash 3.2+），只支持 Linux 宿主机。用 `sh` 调用时脚本会自动 `exec bash` 重新执行自己（这几行本身写成 POSIX sh 兼容），但前提是脚本以文件形式存在（`sh llamapad.sh`）；管道执行时读不到自身文件，无法切换，所以一行安装请用 `| bash`。找不到 `bash` 命令时会报错退出。

一行安装：

```bash
curl -fsSL https://raw.githubusercontent.com/LanceLRQ/llamapad/main/deploy/llamapad.sh | bash
```

`curl | bash` 场景下脚本读不到自己的源文件（`$0` 是管道），安装阶段会按自身版本号重新下载一份落到安装目录（见下文「命令入口」与「文件守卫」的 `place_self`）。

**无 TTY 环境**（脚本需要打开 `/dev/tty` 做交互式菜单/输入；纯管道执行、CI、部分容器环境里没有可用终端）：直接 `curl | bash` 会报错提示改用先下载再执行：

```bash
curl -fsSLO https://raw.githubusercontent.com/LanceLRQ/llamapad/main/deploy/llamapad.sh
bash llamapad.sh
```

**界面语言**：`--lang zh|en` 命令行参数，或环境变量 `LLAMAPAD_LANG`（`zh` 开头判为中文，其余一律英文）；判定优先级 `--lang` > `LLAMAPAD_LANG` > `LC_ALL` > `LANG`。

**安装目录**：`--dir <目录>` 指定，见下文「安装状态检测」的目录解析优先级。

## 命令入口

安装成功后，脚本会在 `/usr/local/bin/llamapad`（可用 `LLAMAPAD_BIN_DIR` 覆盖）写一个两行的启动器脚本，**不是符号链接**：

```sh
#!/bin/sh
export LLAMAPAD_HOME=<安装目录>
exec <安装目录>/llamapad.sh "$@"
```

安装目录写死在启动器里，所以在任意目录执行 `llamapad` 都能正确定位到这份部署，也不依赖 `readlink -f` 解析链接（精简/busybox 环境同样可用）。

- **覆盖确认**：目标路径已存在且指向别的安装（内容不含当前安装目录的 `llamapad.sh` 路径）时，会询问是否覆盖；拒绝则跳过，之后需要直接运行 `<安装目录>/llamapad.sh` 管理。
- **sudo 安装**：`/usr/local/bin` 不可写时，会询问是否用 sudo 写入（`install -m 755`，而非先落地再 `mv`，这样文件属主才会正确变成 root）。
- **跳过后果**：命令入口装不上不影响安装本身完成，只是之后要用完整路径 `<安装目录>/llamapad.sh <命令>` 代替 `llamapad <命令>`。

## 各功能说明

### install（安装向导）

未安装时直接运行脚本（`llamapad.sh` 或 `llamapad`，不带命令）即触发安装。前置条件：平台必须是 Linux、必须能打开 TTY、Docker 环境必须可用（`docker` 命令存在、daemon 可连、非 rootless、有 `compose` v2 插件）。

依次询问以下事项，每项都有默认值，回车即采用；**确认之前不会写入任何配置文件**：

1. **安装目录**（默认 `/opt/llamapad`）：路径不能含空格或冒号；命中禁止路径（见「文件守卫」）会拒绝；目标非空目录会列出最多 10 项内容并询问是否仍要安装到这里；目录已经装过（存在 `.llamapad-state`）则直接进管理菜单；目录里只有手工 compose/`.env`（没有 `.llamapad-state`）则转入「接管」流程（见下文）。
2. **镜像来源**：固定顺序：① Docker Hub 正式版 `lancelrq/llamapad:<脚本版本号>`（本地已缓存会标注）；② 本地已有的、仓库名是 `lancelrq/llamapad` 或 `llamapad` 的镜像（Docker 不可用/没有则不出现这一组）；③ 「从当前仓库构建 `llamapad:dev`」（仅当当前工作目录 `$PWD` 是 llamapad 仓库本体时出现，见下文「build」一节的仓库判定规则）。
3. **模型库位置**：列出各挂载点及其剩余空间、盘类型（NVMe/SSD/HDD/混合/网络/未知）、是否系统盘、空间是否偏低、是否网络盘，也可手动输入绝对路径；目录已存在会报告其中已有多少个 `.gguf` 文件与总大小。
4. **运行身份（PUID:PGID）**：菜单选项按情况而定：模型库已存在时给出「跟随模型库属主」「当前用户」「root」「自定义」；模型库是新建的则给出「普通用户 1000:1000（推荐）」「当前用户」「root」「自定义」。
5. **GPU**：探测 `nvidia-smi -L` 列出的显卡；未检测到显卡则直接不启用；检测到显卡但 Docker 没有 NVIDIA 运行时（`docker info` 的 `Runtimes` 不含 `nvidia`，且找不到 CDI 规格文件）会警告并默认不启用（但仍可强行启用）。
6. **端口与监听地址**：端口须在 1-65535 且当前未被占用（用 `ss`/`netstat`，都没有时退化为解析 `/proc/net/tcp{,6}`）；监听地址三选一：`0.0.0.0`、`127.0.0.1`（建议放在 HTTPS 反代之后时用）、自定义 IPv4。
7. **管理员密码**：留空则随机生成 20 位字母数字串；手填要求至少 8 位、不含单引号，且需要二次确认一致。
8. **时区**：默认探测自 `/etc/timezone` → `timedatectl show -p Timezone` → `/etc/localtime` 软链解析，都拿不到则回退 `UTC`；不能为空或含空格。
9. **外部 LLM**（可选）：用于解析模型 README 里的推荐参数，默认询问是否配置，可直接跳过；稍后也能在面板设置页或 `llamapad config` 里补上。
10. **汇总页**：列出全部选项，选中任意一项可回头修改，也可以直接确认写入或取消安装。

确认后：若镜像来源选了「构建」，先执行本地构建；随后一次性写出全部部署文件（见「目录结构」）；写入成功后询问是否立即拉取镜像并启动；无论是否启动都会打印访问地址、（随机生成时）显示一次性的管理员密码、配置文件路径与常用命令提示。

**接管（adopt）已有的手工部署**：若安装目录里已经有 `docker-compose.yml` 或 `.env`、但没有 `.llamapad-state`，进入接管流程而非全新向导。目录与其中的 `docker-compose.yml`/`docker-compose.gpu.yml`/`.env` 必须对当前用户可读写，否则报错提示换用 sudo（不会贸然改属主）。流程会：从旧 `docker-compose.yml` 与 `.env` 里解析出模型库路径、GPU 开关、镜像名（区分「已是本脚本模板」「Hub 镜像」「自定义/本地构建镜像」三种情形，自定义镜像会问是沿用本地镜像还是改用 Docker Hub 版本）、运行身份、端口、监听地址、时区、LLM 配置；原配置没有可用密码时要求新设一个；展示接管计划并确认；把旧的三个文件备份到 `backups/adopt-<时间戳>/` 后按标准流程写入新配置。**`data/` 与模型库始终不受影响**。

### start（启动）

前置检查（`preflight_start`，均在 `.env` 存在的前提下）：

- `.env` 缺失直接报错，提示重新安装或 `llamapad config`。
- 非 Hub 镜像（本地/构建镜像）时，本地必须已存在该镜像，否则报错提示先 `llamapad build`。
- 每次都按 `docker.sock` 的实际 gid 重新探测并写回 `.env` 的 `DOCKER_GID`（机器迁移、重装 Docker 后 gid 可能变化）。
- 面板未在运行时才检查端口占用（面板本身在跑时占的是自己的端口，不算冲突）。
- 模型库目录必须存在。
- `data/` 目录属主与配置的 PUID:PGID 不一致时警告，并询问是否现在修正（`chown`）。
- 启用了 GPU 却没有 NVIDIA 运行时会报错拒绝启动。

检查通过后 `docker compose up -d`，轮询面板 `/login` 接口至 200（默认超时 60 秒，`LLAMAPAD_READY_TIMEOUT` 可调），成功后打印访问地址。

### restart（重启）

与 start 走相同前置检查，但用 `docker compose up -d --force-recreate` 强制重建容器，因为 compose 默认只在编排本身变化时才重建，而修改 `.env` 里被插值进 compose 的值（端口、密码等）不会触发默认重建，所以配置变更后必须用 `restart` 才能生效。

### stop（停止）

`docker compose stop` 停止面板容器。若还有带 `llamapad.managed=true` 标签的模型容器仍在运行（面板创建的 llama.cpp 兄弟容器），会列出名字提示「停止面板不会停止它们」，并询问是否一并停止。

### status（查看状态）

打印：面板容器状态（未创建过则显示「未创建」）、当前镜像引用、监听地址:端口、正在运行的模型（按 `llamapad.managed=true` 标签的容器读 `llamapad.model` 标签）、GPU 信息（`nvidia-smi` 存在时输出显卡名/显存用量）、`data/` 与模型库所在磁盘的剩余空间。

### logs（查看日志）

`docker compose logs --tail 200`；加 `-f`/`--follow` 参数持续跟随输出。菜单里的「查看日志」项固定只看最近 200 行，不跟随，跟随需用命令行 `llamapad logs -f`。

### config（修改配置）

菜单形式，可改：端口（面板正运行时占用的当前端口不算冲突）、监听地址、模型库位置（**只改路径，不搬文件**：已有模型配置的路径是相对模型库根目录写的，换位置后需自己把文件搬过去）、运行身份（会先尝试 `chown` 数据目录，失败则不写入新 PUID/PGID，避免出现「配置已改但目录属主没跟着变」的中间态）、GPU 开关、时区、外部 LLM、管理员密码（改密码后所有已登录浏览器需重新登录，API Token 不受影响）。任何一项改动后，退出菜单时会询问是否立即重建容器生效（不立即生效则提示之后执行 `llamapad restart`）。

### build（构建镜像）

**仓库定位顺序**：`--repo <路径>` 优先 > 当前工作目录 `$PWD` > 之前 `build` 记在 `.llamapad-state` 里的 `build_repo`（只在它仍是仓库时才采用）。判定某目录是不是 llamapad 仓库本体的规则（`repo_detect`）：该目录下必须同时有 `Dockerfile`，和 `package.json`（其 `"name"` 字段的值必须是 `"llamapad"`）。

**这个判定只看当前目录，不看脚本文件本身放在哪里**，所以要么在仓库根目录下执行（例如 `bash deploy/llamapad.sh build`），要么显式传 `--repo <仓库路径>`。找不到仓库会报错，提示在仓库根目录运行或指定 `--repo`。

镜像 tag 固定为 `llamapad:dev`（不随仓库名或机器变化）。构建时若环境里设置了 `HTTP_PROXY`/`HTTPS_PROXY`（大小写形式都识别，优先取大写），会作为 `--build-arg` 透传给 `docker build`。

行为按是否已安装分两种：

- **已安装**（存在有效的 `.llamapad-state`）：构建镜像 → 把 `.env` 的 `LLAMAPAD_IMAGE`/`LLAMAPAD_VERSION` 改成 `llamapad`/`dev` → 在 state 里记录 `image_source=build` 与 `build_repo` → 询问是否立即重建容器生效。
- **未安装**：`llamapad build` 依然可用，只是单纯构建出 `llamapad:dev` 镜像，**不写任何配置**；完成后提示：之后运行安装向导时会在「镜像来源」里自动列出这个本地镜像，或者对一个已存在的其他安装用 `--dir <安装目录>` 再执行一次 `build` 来切换到它。

主菜单里的「构建镜像」项**只在能定位到仓库时才出现**（判定顺序同上）。

### upgrade（升级）

**Hub 镜像流程**：菜单标题栏每次显示时，会做一次「至多 24 小时一次」的联网查询 Docker Hub 最新正式版本（`update_checked_at`/`update_latest` 记在 `.llamapad-state`，查询超时 2 秒、失败不影响任何流程），有更新会在菜单头提示「有新版本」。`llamapad upgrade` 默认取该最新正式版本作为目标，也可用 `--to <版本号>` 指定任意版本（含降级）。降级会先警告「数据库迁移只进不退，旧版本可能读不了数据」。确认升级后：

1. 若目标脚本版本与当前不同，先做**脚本自更新**（两阶段：下载新版本脚本、`bash -n` 语法检查、精确匹配 `LLAMAPAD_SCRIPT_VERSION="<目标版本>"` 这一行内容确认版本无误、备份旧脚本到 `backups/llamapad.sh.<时间戳>` 后替换、`exec` 到新脚本继续执行第二阶段）；自更新失败时会问是否「仅升级镜像，脚本保持当前版本」。
2. 模板同步（见「文件守卫」的模板校验部分）。
3. `docker compose pull` 拉取新镜像；**拉取失败会回滚**：恢复 `.env` 里的版本号（与镜像名，如果本次有改）、回滚模板同步的改动，报错并提示网络受限时配置 `registry-mirrors` 或代理。
4. 拉取成功后 `docker compose up -d --force-recreate`；这一步失败**不回滚**镜像名与版本号（视为「镜像已经是新的，只是容器没重建成功」），提示排查后手动 `llamapad start`。

**本地镜像流程**：当前用的不是 Docker Hub 镜像时，`upgrade` 改问一个菜单：「从仓库重新构建并重建容器」（等价于走一遍 `build`，只在能定位到仓库时出现这一项）/「切换到 Docker Hub 正式版」/「取消」。选切换 Hub 会走与上面相同的升级流程，只是这次镜像名也要跟着改写，确认升级之前不改动 `.env`，失败按上面的规则回滚镜像名与版本号。

`--to` 可配合网络受限场景使用（跳过联网查询最新版本这一步）。

### doctor（环境自检）

逐项检查并打印 `✔`（通过）/`⚠`（警告，不计入失败数）/`✘`（失败，计入失败数）：

| 检查项 | ✔ 通过 | ⚠ 警告 | ✘ 失败 |
|---|---|---|---|
| 宿主机平台 | 是 Linux | — | 非 Linux |
| Docker 可用性 | 命令存在、daemon 可连、非 rootless、有 compose v2 | 需要经 sudo 访问 docker.sock | 缺 docker / daemon 连不上 / rootless / 缺 compose v2 |
| 镜像是否就绪 | 本地已有对应镜像 | Hub 镜像尚未拉取（首次启动会自动拉） | 非 Hub 的本地/构建镜像本地不存在（提示 `llamapad build`） |
| `.env` 必填项 | `LLAMAPAD_VERSION`/`PANEL_ADMIN_PASSWORD`/`DOCKER_GID` 都有值 | — | 缺任意一项 |
| `DOCKER_GID` | 与 `docker.sock` 实际 gid 一致 | — | （不一致时是 warn：提示 `start` 会自动修正，不计入失败） |
| GPU | 未启用且无显卡 / 已启用且运行时可用 | 有显卡但未启用（无显存监控） | 已启用但 NVIDIA 运行时缺失 |
| 端口 | 面板正占用（运行中）/ 空闲 | — | 未运行但端口被其他进程占用 |
| `data/` 属主 | 与 PUID:PGID 一致 | — | 不一致 |
| 模型库 | 目录存在，磁盘剩余空间充足 | 剩余空间偏低（< 100GB） | 目录不存在 |
| compose 模板 | — | 被手动修改过（升级时会展示差异并询问） | — |

结尾汇总：全部通过打印「自检全部通过」；否则打印失败项数量，命令返回非零。

### uninstall（卸载）

1. 确认是否停止并删除面板容器（不影响模型容器、数据与模型文件）；确认后 `docker compose down`。
2. 命令入口 `/usr/local/bin/llamapad` 若指向本安装，一并移除（需要权限时经 sudo）。
3. 提示「容器已移除，安装目录仍保留」，再次询问是否连安装目录一起删除。
4. 若同意：模型库在安装目录内会警告「将一并删除」，在外则提示「不会删除」；列出安装目录里所有不属于 llamapad 已知产物的「外来文件」（这些也会被一并删除）；要求手动输入安装目录名二次确认，输错直接放弃删除。
5. 确认无误后调用 `safe_remove_home`（见「文件守卫」）真正删除目录。

### help / version

`llamapad help`（或 `-h`/`--help`）打印用法、全部命令与选项说明；`llamapad version` 打印脚本版本号（即 `LLAMAPAD_SCRIPT_VERSION`）。

### 主菜单项一览

不带命令直接运行已安装的 `llamapad` 进入方向键菜单，固定顺序：**启动/重启**（按当前是否在运行切换标签）、停止、查看状态、查看日志、修改配置，**「构建镜像」仅当能定位到仓库时才插入**，然后是升级、环境自检、卸载、退出。菜单头会显示脚本版本、当前镜像（Hub 镜像显示版本号并在有更新时提示；本地/构建镜像显示完整镜像引用）、安装目录、面板运行状态、正在运行的模型、以及一条可访问地址。

## 安装状态检测

**安装目录解析优先级**：`--dir` > 环境变量 `LLAMAPAD_HOME`（命令入口启动器导出的就是它）> 脚本自身所在目录（仅当能读到脚本自身文件时，即非 `curl | bash` 场景）。这个优先级只用于「找到已有安装」；**新装的默认目录**只取显式给出的 `--dir` 或 `LLAMAPAD_HOME`（`/opt/llamapad` 是进一步的兜底默认值），不会用脚本所在目录，否则在仓库里直接跑脚本时默认目录会变成 `deploy/`。

**目录状态判定**（`dir_state`）：

| 状态 | 判定条件 | 行为 |
|---|---|---|
| `installed` | 存在 `.llamapad-state` | 直接进管理菜单/执行管理命令 |
| `adopt` | 没有 `.llamapad-state`，但有 `docker-compose.yml` 或 `.env` | 走「接管」流程 |
| `empty` | 都没有 | 走全新安装向导 |

`.llamapad-state` 在 `apply_install`（全新安装与接管共用的落盘函数）里**最后写入**，就是为了让半路失败的安装重新运行时能被判为 `empty`/`adopt` 重新走一遍向导，而不是被误判为「已安装」直接跳过。

**未安装时执行管理命令**（`start`/`stop`/`restart`/`status`/`logs`/`config`/`upgrade`/`doctor`/`uninstall`）会报错「尚未安装」并提示先安装或用 `--dir` 指定安装目录。**唯一例外是 `build`**：它只依赖能定位到仓库和 Docker 可用，不依赖已安装（见上文「build」一节）。

**手动检查安装状态**：

```bash
cat /opt/llamapad/.llamapad-state   # 直接看 state 文件
llamapad status                     # 面板容器状态、镜像、监听地址
llamapad doctor                     # 完整环境自检
llamapad version                    # 脚本版本号
```

## 安装目录结构与文件

默认安装目录 `/opt/llamapad`，默认端口 `28960`。

| 路径 | 说明 |
|---|---|
| `llamapad.sh` | 脚本本体的副本（安装时复制/下载进来，之后 `llamapad` 命令都执行这一份，不是原始下载位置的那份） |
| `docker-compose.yml` | 主编排文件，内嵌模板逐字节写出 |
| `docker-compose.gpu.yml` | GPU 叠加层，`.env` 的 `COMPOSE_FILE` 含它时才生效 |
| `.env` | 部署参数，`chmod 600`；可以手改，脚本按键原地替换、不重排、不删除你的注释与额外变量 |
| `.llamapad-state` | 脚本自身的状态记录（非 compose 用），下表列出全部键 |
| `data/` | 挂载到容器内 `/app/config`：`panel.yaml`、`panel.db`、YAML 快照、日志等面板数据 |
| `models/` | 模型库默认位置（可在向导/`config` 里改到别处） |
| `backups/` | `chmod 700`；存放接管前的旧文件备份（`adopt-<时间戳>/`）、模板被替换前的备份、脚本自更新前的备份 |

`.env` 关键变量：

| 变量 | 含义 |
|---|---|
| `LLAMAPAD_IMAGE` | 镜像仓库名（省略等价于 Hub 镜像 `lancelrq/llamapad`） |
| `LLAMAPAD_VERSION` | 镜像 tag /版本号（必填） |
| `PANEL_ADMIN_PASSWORD` | 管理员密码（必填） |
| `DOCKER_GID` | `docker.sock` 的 gid（必填，每次 start 自动校正） |
| `PUID` / `PGID` | 容器运行身份 |
| `PANEL_BIND` / `PANEL_PORT` | 监听地址与端口 |
| `MODELS_DIR` | 模型库路径（相对安装目录或绝对路径） |
| `COMPOSE_FILE` | 是否叠加 GPU 层 |
| `TZ` | 容器时区 |
| `PANEL_LLM_BASE_URL` / `PANEL_LLM_API_KEY` / `PANEL_LLM_MODEL` | 外部 LLM（可选） |

`env_set` 只按键原地替换首个同名行（多余同名行会被删除），缺失则追加，其余内容一律保留，手改 `.env` 是安全的。

`.llamapad-state` 全部键：

| 键 | 含义 |
|---|---|
| `installed_at` | 安装完成时间（UTC） |
| `template_version` | 已写入的 compose 模板版本号 |
| `compose_sha256` | `docker-compose.yml` 的校验和（升级时据此判断是否被手改） |
| `gpu_compose_sha256` | `docker-compose.gpu.yml` 的校验和 |
| `image_source` | `hub` / `local` / `build` |
| `build_repo` | `image_source=build` 时记录的仓库路径 |
| `adopted_from` | 接管场景下，旧文件备份目录的路径 |
| `update_checked_at` | 上次查询 Docker Hub 最新版本的时间戳 |
| `update_latest` | 查到的最新正式版本号 |

安装过程中还会出现的临时文件（正常情况下会自动清理，不必手动处理）：`.env.tmp.*`、`.llamapad-state.tmp.*`（`env_set`/`state_set` 写入用）、`.llamapad.sh.new`（自更新下载中）、`.llamapad.sh.tmp`（`place_self` 落地中）、`.llamapad-launcher.tmp`（命令入口落地中）、`.docker-compose*.yml.new`（模板同步中）。

## 文件守卫与安全机制

**禁止用作安装/删除目标的路径**（`path_forbidden`）：空字符串、`/`、`$HOME`、含 `/../` 片段或以 `/..` 收尾的路径，以及以下系统/挂载顶层目录本身（精确匹配，子目录不受影响，唯独 `/usr` 连子目录一并拒绝）：

```
/opt  /usr  /usr/*  /home  /root  /etc  /var  /bin  /sbin
/lib  /lib64  /boot  /srv  /mnt  /media  /data  /tmp  /proc  /sys  /dev  /run
```

其他守卫机制：

- **路径格式**：安装目录不能包含空格或冒号。
- **非空目录警告**：目标目录存在且非空时列出最多 10 项内容，并建议改用空目录，需要用户再次确认才会继续。
- **权限检查**：`home_access_ok`（管理命令入口，要求安装目录可写、`.env` 若存在需可读写）与 `adopt_access_ok`（接管场景，要求目录及其中已有的 `docker-compose.yml`/`docker-compose.gpu.yml`/`.env` 都对当前用户可读写）不通过时报错提示改用 `sudo llamapad`，而不是自作主张改属主。
- **compose 模板一致性**：内嵌在脚本里的 `tpl_compose`/`tpl_compose_gpu` 必须与仓库里的 `deploy/docker-compose.yml`/`deploy/docker-compose.gpu.yml` 逐字节一致（测试守护）；每次写出模板都把校验和记进 `.llamapad-state`。升级时若模板版本号提升，会重新比对：本地文件校验和与 state 记录一致（用户没手改过）就静默替换；不一致则展示 `diff -u` 差异并询问是否替换（**默认保留原文件**），替换前先备份到 `backups/`，若升级流程后续失败（例如 `compose pull` 失败）会回滚这次模板替换与校验和记录。
- **`.env` 值校验**：值含单引号或换行一律拒绝写入（因为写入用单引号包裹，两者都无法安全表达）。
- **自更新守卫**（`self_update`）：下载后先 `bash -n` 做语法检查；再精确匹配 `LLAMAPAD_SCRIPT_VERSION="<目标版本>"` 这一整行，内容不符视为下载到错误内容一律放弃；替换旧脚本前先备份到 `backups/llamapad.sh.<时间戳>`；下载/校验期间收到 Ctrl-C 会清理掉半截的临时文件（`.llamapad.sh.new`）再退出。
- **`place_self` 下载回退**：装不到脚本自身文件时（`curl | bash`），按自身版本号对应的 tag（`vX.Y.Z`）下载，找不到该 tag 再回退到 `main` 分支，下载后同样过一遍 `bash -n` 语法检查才落盘。
- **模型库绝不误 chown**：只有向导里判定为「新建」的模型目录才会对齐运行身份的属主；已存在的模型库（往往上百 GB）永远不会被脚本改属主。
- **卸载守卫**（`safe_remove_home`）：删除安装目录前二次校验：目标不能命中 `path_forbidden`，且必须存在 `.llamapad-state`（证明确实是脚本自己的安装目录），并要求用户手动输入目录名二次确认；会列出目录里所有不属于已知产物的「外来文件」提前告知都会被删除；模型库在安装目录内时额外警告。
- **命令入口只在指向别处时才询问覆盖**：`/usr/local/bin/llamapad` 内容已经指向本次安装目录时直接跳过，不重复询问。
- **终端状态恢复**：交互式菜单会临时关掉终端回显与行缓冲、隐藏光标；脚本正常退出、被 `Ctrl-C`/`kill` 中断，或收到 `INT`/`TERM` 信号时都会通过 `trap` 恢复终端原状态，不会把终端留在不可用的状态。

## 环境变量覆盖表

| 变量 | 含义 | 默认值 |
|---|---|---|
| `LLAMAPAD_HOME` | 安装目录（命令入口启动器导出） | 无（回退脚本自身目录） |
| `LLAMAPAD_LANG` | 界面语言 | 无（回退 `LC_ALL`/`LANG`） |
| `LLAMAPAD_RAW_BASE` | 下载脚本本体/自更新用的 raw 地址前缀 | `https://raw.githubusercontent.com/LanceLRQ/llamapad` |
| `LLAMAPAD_HUB_TAGS_URL` | 查询 Docker Hub 版本列表的 API 地址 | `https://hub.docker.com/v2/repositories/lancelrq/llamapad/tags?page_size=100` |
| `LLAMAPAD_READY_TIMEOUT` | 启动后等待面板就绪的超时秒数 | `60` |
| `LLAMAPAD_BIN_DIR` | 命令入口安装目录 | `/usr/local/bin` |
| `LLAMAPAD_DOCKER_BIN` | docker 可执行文件名/路径（测试注入桩） | `docker` |
| `LLAMAPAD_SUDO` | sudo 可执行文件名（测试注入桩） | `sudo` |
| `LLAMAPAD_NVIDIA_SMI` | nvidia-smi 可执行文件名/路径（测试注入桩） | `nvidia-smi` |
| `LLAMAPAD_DOCKER_SOCK` | docker.sock 路径（测试注入桩） | `/var/run/docker.sock` |
| `LLAMAPAD_SYSFS` | `/sys` 路径（测试注入桩） | `/sys` |
| `LLAMAPAD_PROC` | `/proc` 路径（测试注入桩） | `/proc` |
| `LLAMAPAD_ETC` | `/etc` 路径（测试注入桩） | `/etc` |
| `LLAMAPAD_TTY` | 交互终端设备路径（测试注入桩） | `/dev/tty` |
| `LLAMAPAD_PLAIN` | 设为 `1` 强制退化为数字菜单（不依赖 ANSI/TTY 光标控制） | 无（自动判定） |
| `LLAMAPAD_SKIP_PLATFORM_CHECK` | 设为 `1` 跳过「必须是 Linux」检查（测试用） | 无 |
| `LLAMAPAD_SOURCE_ONLY` | 设为 `1` 时脚本只定义函数、不执行 `main`（供测试 `source` 用） | 无 |
| `NO_COLOR` | 设置后（任意值）禁用终端颜色（非 `LLAMAPAD_` 前缀，但常与本脚本一起用） | 无 |
| `HTTP_PROXY` / `HTTPS_PROXY`（含小写） | `build` 时透传给 `docker build --build-arg` | 无 |

以下三个是**内部跨版本接口，仅供脚本自身在自更新时于两个版本进程之间传递升级状态，不要手动设置**：

| 变量 | 用途 |
|---|---|
| `LLAMAPAD_UPGRADE_STAGE` | 标记自更新后 `exec` 出的第二阶段进程 |
| `LLAMAPAD_UPGRADE_CONFIRMED` | 标记升级已在第一阶段确认过，第二阶段不再重复询问 |
| `LLAMAPAD_UPGRADE_REVERT_IMAGE` | 本地镜像切换到 Hub 镜像时，记录切换前的原镜像名以便失败回滚 |

## 常见问题

| 现象 | 处理 |
|---|---|
| docker 命令要 sudo 才能跑 | 脚本会自动探测并在需要时通过 sudo 执行 docker 命令（可能要求输入密码）；想免 sudo 可把当前用户加入 `docker` 组后重新登录 |
| 检测到 rootless Docker | 暂不支持（面板需要挂载 `/var/run/docker.sock`），需改用标准（非 rootless）Docker 部署 |
| 缺少 `docker compose` v2 插件 | 参考 https://docs.docker.com/compose/install/linux/ 安装插件 |
| 启用了 GPU 但没有 NVIDIA 运行时 | 安装 `nvidia-container-toolkit`，或用 `llamapad config` 关闭 GPU |
| 端口被占用 | 用 `llamapad config` 换一个端口，或先停掉占用该端口的进程 |
| `data/` 属主与运行身份不一致 | `llamapad start`/`doctor` 会检测到并提示修正；也可手动 `chown -R <PUID>:<PGID> data` |
| 网络受限，连不上 GitHub / Docker Hub | 脚本本体下载地址用 `LLAMAPAD_RAW_BASE` 指向可达的镜像；镜像拉取失败给 Docker 配 `registry-mirrors` 或代理；查最新版本失败时改用 `llamapad upgrade --to <版本号>` 跳过联网查询 |
