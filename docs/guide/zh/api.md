# 面板 API

面板的每一个界面操作背后都是一次 HTTP 请求，这些接口同样可以被脚本直接调用。适合用来做定时备份、把模型启停接进自己的运维流程、把下载任务和监控数据接到别的系统里。

推理请求走的是另一套入口，见[推理接口](./inference.md)。

## 通用约定

### 基址

```
http://<服务器地址>:28960/api/v1
```

本文中出现的路径都省略了这个前缀。例如「`GET /models`」的完整地址是 `http://<服务器地址>:28960/api/v1/models`。

### 鉴权

在「设置 → 账号与数据 → 账号与安全」签发 API Token，明文只在签发那一刻显示一次。请求时带在 `Authorization` 头里：

```bash
curl -s http://<服务器地址>:28960/api/v1/models \
  -H "Authorization: Bearer lp_xxxxxxxx"
```

未通过鉴权一律返回 401 `{"error":"unauthorized"}`。

有两个例外需要留意：

- **账号安全相关的四个接口不接受 Token 鉴权。** `/auth/tokens` 系列三个（列表 / 签发 / 吊销）加上 `PUT /auth/password`，都只认浏览器登录的会话，用 `lp_…` 调用会 401。这样即使某个 token 泄漏了，拿到它的人也无法用它签发新 token、吊销别人的 token 或改掉管理员密码。
- **浏览器的 `EventSource` 用不了 Bearer。** 它的 API 不支持自定义请求头，只能靠同源页面的登录状态。脚本里订阅 SSE 请用支持自定义头的 HTTP 客户端（`curl -N`、`fetch` 加 `ReadableStream`、Python `httpx` 等）。

吊销 token 立即生效，正在使用它的程序下一次请求就会 401。改密码不会吊销已签发的 token。

### 请求与响应格式

写操作的请求体是 JSON，需要带 `Content-Type: application/json`。响应一律是 JSON。

时间字段有两种形式，取哪一种要看具体接口：多数配置类接口用 ISO 字符串（`2026-09-02T01:23:45.000Z`），运行历史与监控数据点用毫秒时间戳数字。

### 错误

错误响应的形状是 `{"error": "…"}`。请求体校验失败时额外带一个 `issues` 数组，指出是哪个字段出的问题：

```json
{
  "error": "invalid_body",
  "issues": [{ "path": "name", "message": "..." }]
}
```

常见状态码：

| 状态码 | 含义 |
| --- | --- |
| 400 | 请求体或参数不合法 |
| 401 | 未鉴权或凭据无效 |
| 404 | 目标不存在 |
| 409 | 与当前状态冲突（重名、运行中禁止操作、启停操作正在进行） |
| 422 | 参数合法但服务端拒绝执行（启动时模型文件缺失、`reasoning_effort` 取值不被该模型的对话模板接受） |
| 423 | 目标被运行中的模型占用 |
| 500 | 服务端异常 |

少数接口另有专用状态码：下载入队在磁盘空间不足时返回 507，下载源连通性测试失败返回 502。

## 常用任务

下面的例子统一用这两个变量：

```bash
PANEL=http://<服务器地址>:28960/api/v1
TOKEN=lp_xxxxxxxx
```

### 查看当前运行的模型

```bash
curl -s "$PANEL/runtime/status" -H "Authorization: Bearer $TOKEN"
```

```json
{
  "running": {
    "model": "qwen3-30b",
    "displayName": "Qwen3 30B",
    "container": "llamapad-llama",
    "startedAt": "2026-09-02T01:20:00.000Z",
    "hostPort": 18080,
    "configStale": false,
    "ready": true
  }
}
```

没有模型在跑时 `running` 是 `null`。

其中两个字段决定了脚本该怎么写：

- **`ready`** 表示 llama-server 是否已经可以接受请求。容器起来到真正就绪之间有一段时间，大模型上可能是几十秒，这期间 `ready` 是 `false`。脚本里判断「模型可用了吗」要看这个字段，不能只看 `running` 非空。
- **`configStale`** 为 `true` 表示这个模型的配置在启动之后被改过，当前跑的还是旧参数，需要重启才生效。

加上 `?busy=1` 会额外返回一个 `busy` 字段，告诉你当前是否正在生成内容、占用了几个槽位。它需要向模型服务多发一次探测请求，用于「等空闲了再重启」这类场景，不要放进高频轮询。

`busy` 为 `null` 表示**探测不到**，不表示空闲——没有模型在跑、或者探测请求本身失败时都是这个值。写「等空闲」逻辑时不要把它当成可以动手的信号。

### 启动、停止与切换模型

```bash
# 启动（或从别的模型切过来——面板同一时刻只跑一个，会自动停掉旧的）
curl -s -X POST "$PANEL/models/qwen3-30b/start" -H "Authorization: Bearer $TOKEN"

# 停止
curl -s -X POST "$PANEL/models/qwen3-30b/stop" -H "Authorization: Bearer $TOKEN"

# 重启（改完配置让新参数生效）
curl -s -X POST "$PANEL/models/qwen3-30b/restart" -H "Authorization: Bearer $TOKEN"
```

启动成功返回 `{"id": "<容器 id>"}`，停止返回 `{"ok": true}`。

写脚本时这三点最容易出错：

**返回 200 不代表模型已经能用。** 接口在 Docker 发出启动指令后就返回了，权重还在加载。要等到真正可用，得轮询 `runtime/status` 直到 `ready` 为 `true`：

```bash
curl -s -X POST "$PANEL/models/qwen3-30b/start" -H "Authorization: Bearer $TOKEN"

until curl -s "$PANEL/runtime/status" -H "Authorization: Bearer $TOKEN" \
      | grep -q '"ready":true'; do
  sleep 3
done
echo "已就绪"
```

**同一时刻只允许一个启停操作。** 前一个还没做完就发第二个，会返回 409 并说明当前正在进行什么操作。这是为了避免第二次启动把第一次正在加载的容器杀掉。脚本里遇到 409 应该等待重试，而不是当成失败退出。

**对已经在运行的模型再次调用 start 会重建容器**，不是空操作。要判断是否需要启动，先查 `runtime/status`。

停止时可以要求先等当前对话生成完：

```bash
curl -s -X POST "$PANEL/models/qwen3-30b/stop" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"drain": true, "drainTimeoutMs": 60000}'
```

响应里的 `drain.reason` 说明实际结果：`idle` 是等到空闲了，`timeout` 是等超时后仍然停止，`unavailable` 是探测不到忙碌状态、直接放行，`skipped` 是压根没执行这次探测（例如拿不到模型端口）。后两种都不代表「已经空闲」。

`drainTimeoutMs` 的取值范围是 1000–600000 毫秒（1 秒到 10 分钟），超出这个范围会返回 400。不带 `drain` 字段时不会做任何等待。

### 启动前检查显存

```bash
curl -s "$PANEL/models/qwen3-30b/preflight" -H "Authorization: Bearer $TOKEN"
```

```json
{ "verdict": "warn", "freeMib": 8192, "totalMib": 24576, "peakNetMib": 19000, "runCount": 3 }
```

`verdict` 三种取值：`ok` 空闲显存够、`warn` 可能不够、`unknown` 缺少判断依据（没有历史运行记录，或读不到显卡读数）。

这是**提示性质**的，不影响启动接口的行为——判断依据是这个模型过去几次运行的显存峰值，而实际占用受量化、上下文长度等多个因素影响，给不出精确预测。

### 提交下载并跟踪进度

直链下载：

```bash
curl -s -X POST "$PANEL/downloads/direct" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com/model.gguf","targetDir":"main"}'
```

返回 202 和一组任务 id。`targetDir` 是相对模型库根目录的路径，`filename` 可选，不填时从链接末段推导。

查询进度有两种方式。轮询：

```bash
curl -s "$PANEL/downloads" -H "Authorization: Bearer $TOKEN"
```

返回 `{ "tasks": [...], "history": [...] }`。每个任务的 `status` 是 `pending` / `downloading` / `paused` / `completed` / `failed` / `cancelled` 之一，`downloadedBytes` 与 `expectedSize` 用来算百分比。

或者订阅进度流，每秒推送一次全量快照：

```bash
curl -N "$PANEL/downloads/stream" -H "Authorization: Bearer $TOKEN"
```

这个流不会自己结束，也不区分事件类型——每一帧的 JSON 里有个 `type` 字段，`tasks` 是任务快照，`history` 是连接建立时推送一次的历史记录。判断「下载完了没有」要看任务的 `status`，不要等服务端关闭连接。

单个任务可以暂停、继续、取消、重试：

```bash
curl -s -X POST "$PANEL/downloads/12/pause"  -H "Authorization: Bearer $TOKEN"
curl -s -X POST "$PANEL/downloads/12/resume" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "$PANEL/downloads/12/cancel" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "$PANEL/downloads/12/retry"  -H "Authorization: Bearer $TOKEN"
```

注意区分 `POST /downloads/resume`（恢复整个队列）和 `POST /downloads/<id>/resume`（恢复单个任务），两者路径相似但作用不同。

### 读取监控数据

当前读数分三个来源，各自独立取：

```bash
curl -s "$PANEL/container/stats" -H "Authorization: Bearer $TOKEN"  # 容器 CPU/内存与推理指标
curl -s "$PANEL/gpu/stats"       -H "Authorization: Bearer $TOKEN"  # 显卡显存、利用率、温度
curl -s "$PANEL/host/stats"      -H "Authorization: Bearer $TOKEN"  # 宿主机 CPU、内存、负载、磁盘与网络
```

显卡读数在没有 GPU 或还没探测完成时，返回的仍然是 200，靠响应里的 `status` 字段区分，不要按 HTTP 状态码判断。

历史曲线用窗口查询：

```bash
curl -s "$PANEL/metrics/window?range=2h" -H "Authorization: Bearer $TOKEN"
```

`range` 只接受 `30m` / `2h` / `24h` / `7d` 四个值，其他值返回 400。响应里 `series` 是各项指标的数据点数组，`from` 是窗口起点的毫秒时间戳。

持续采集时可以带上 `since=<上次拿到的最新时间戳>`，只取新增的点。这时响应里 `mode` 会是 `delta`。**两种模式下空数组的含义相反**：`full` 模式下空数组表示这项指标没有采集到过，`delta` 模式下空数组只是表示这一轮没有新点。判断依据要看 `mode` 字段，不要自己推断。

### 订阅事件与日志

面板记录的操作事件（模型启停、下载完成、登录、配置变更等）：

```bash
curl -s "$PANEL/events" -H "Authorization: Bearer $TOKEN"          # 查历史
curl -N "$PANEL/events/stream" -H "Authorization: Bearer $TOKEN"   # 实时订阅

# 只看某一类事件，并多取几条
curl -s "$PANEL/events?kind=model.start_failed&limit=50" \
  -H "Authorization: Bearer $TOKEN"
```

`limit` 默认 20、上限 100，非法值静默回落默认值；`kind` 是精确匹配，取值如 `model.start`、`model.stop`、`model.update`、`model.delete`、`model.start_failed`。

运行中模型的容器日志：

```bash
curl -N "$PANEL/logs/stream" -H "Authorization: Bearer $TOKEN"
```

两个流的断线行为不同：日志流的每条日志带序号，重连时带上 `Last-Event-ID` 头可以补发断开期间的内容（补发范围是最近的一批，断太久会有缺口）；事件流不支持补发，重连后靠重新推送一次快照对齐。

### 环境自检

```bash
curl -s "$PANEL/doctor" -H "Authorization: Bearer $TOKEN"
```

逐项返回 Docker 连通性、模型库路径、磁盘空间、GPU、下载源等检查结果，每项的结论是 `ok` / `warn` / `fail`。适合放进部署后的验收脚本。注意 GPU 与下载源检测失败记为 `warn` 而不是 `fail`——纯 CPU 部署和不用 Hugging Face 都是合法形态。

### 备份与恢复配置

导出分两种，行为差别很大。

**单个模型**——直接把 YAML 内容作为响应返回，可以存成文件：

```bash
curl -s -X POST "$PANEL/export?model=qwen3-30b" \
  -H "Authorization: Bearer $TOKEN" -o qwen3-30b.yaml
```

**全部配置**——服务端打包成 zip 写在自己的磁盘上，响应里给的是**路径和体积，不是文件内容**：

```bash
curl -s -X POST "$PANEL/export" -H "Authorization: Bearer $TOKEN"
# {"path":"/app/config/export/llamapad-20260902T031405Z.zip","bytes":8421}
```

要把这个 zip 取回来，去部署目录的 `data/export/` 下找（这个目录挂载到了容器里的 `/app/config/export`）。

如果目的只是「有一份可以随时回滚的配置备份」，比走接口更省事的做法是打开设置页的自动快照开关——每次配置变更都会把全量配置写进 `data/export/latest.yaml`，把这个目录纳入 git 就是一份带历史的备份。

恢复用导入接口，请求体是 JSON，YAML 全文放在 `content` 字段里：

```bash
curl -s -X POST "$PANEL/import" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "$(jq -Rs '{content: ., format: "llamapad", strategy: "skip"}' backup.yaml)"
```

`strategy` 决定同名模型怎么处理：`skip` 跳过（默认）、`rename` 改名导入、`overwrite` 覆盖。

正式导入前可以先用 `POST /import/preview` 预检，请求体只要 `content` 和 `format`。它不写任何东西，只告诉你会导入哪些模型、以及每个模型引用的文件在本机存不存在。

YAML 的字段结构、以及从 bash 版 llama-launcher 迁移的做法，见[配置格式与迁移](./config.md)。

### 管理文件

```bash
# 目录树与每个文件的引用数
curl -s "$PANEL/files/tree" -H "Authorization: Bearer $TOKEN"

# 某个文件被哪些模型引用
curl -s "$PANEL/files/refs?path=main/model.gguf" -H "Authorization: Bearer $TOKEN"

# 删除（被引用时返回 409，加 force 才真删）
curl -s -X DELETE "$PANEL/files" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"path":"main/old.gguf"}'
```

请求里的路径都相对模型库根目录，不是宿主机的绝对路径。

删除与移动都带引用检查：文件正被某个模型配置引用时返回 409 并列出是哪些模型；引用它的模型正在运行时返回 423，这种情况加 `force` 也不放行，得先把模型停掉。移动和改名会自动改写所有指向它的模型配置，不需要你逐个去改。

分片组按整组处理——对其中任意一个分片发起移动或改名，同组其余分片会一起走。

## 使用时需要注意的

**写操作的副作用不总是能从路径看出来。** 改模型配置、命名空间、导入这几类操作会连带更新配置快照文件；文件移动会改写引用它的模型配置。做批量操作前建议先导一份备份。

**部分操作不是全有全无。** 批量删除遇到非法路径会中断，此前已经删掉的文件不会恢复，响应里也不会列出删了哪些。文件移动如果文件已经挪好、但配置改写失败，会返回 500 并提示配置未更新——这种情况文件在新位置、配置还指着旧路径，需要人工核对。

**有的接口是异步的，结果要另外去取。** 计算文件完整哈希的接口返回 202 就结束了，实际计算在后台跑，结果要再查一次文件元信息，或者从事件流里等。反过来，「自动寻找」接口是同步的，它要扫描整个模型库逐个比对哈希，文件多时会明显慢，别给它设太短的超时。

**镜像拉取用的是 SSE 而不是普通响应。** HTTP 状态码始终是 200，成功与失败都体现在流里的 `type` 字段（`progress` / `done` / `error`），不要按状态码判断结果。

**清空凭据要传 `null` 而不是空字符串。** 设置类接口里传空字符串会被当成非法值拒绝。

## 完整端点清单

以下路径都省略了 `/api/v1` 前缀。

### 鉴权与账号

| 方法与路径 | 说明 |
| --- | --- |
| `POST /auth/login` | 用管理员密码登录，签发会话 cookie |
| `POST /auth/logout` | 注销当前会话 |
| `GET /auth/me` | 当前登录状态 |
| `PUT /auth/password` | 修改管理员密码（需验证旧密码） |
| `POST /auth/setup` | 首次初始化管理员，已初始化后返回 403 |
| `GET /auth/tokens` | API Token 列表（只显示后 4 位） |
| `POST /auth/tokens` | 签发新 Token，明文只返回这一次 |
| `DELETE /auth/tokens/{id}` | 吊销 Token |

这四个接口只接受会话 cookie，不接受 Token 鉴权（`PUT /auth/password` 同属此列，见上文「鉴权」一节）。

### 模型与运行

| 方法与路径 | 说明 |
| --- | --- |
| `GET /models` | 模型列表，含运行状态与文件状态 |
| `POST /models` | 新建模型配置 |
| `GET /models/{name}` | 单个模型的配置 |
| `PUT /models/{name}` | 修改模型配置；模型运行中也能保存，但不会热更新容器，要重启才生效 |
| `DELETE /models/{name}` | 删除模型配置，不删磁盘文件 |
| `GET /models/{name}/effective` | 生效参数：默认配置与该模型覆盖项合并后的结果 |
| `GET /models/{name}/preflight` | 启动前的显存提示 |
| `POST /models/{name}/start` | 启动 |
| `POST /models/{name}/stop` | 停止 |
| `POST /models/{name}/restart` | 重启 |
| `POST /models/{name}/move` | 改命名空间，不动文件 |
| `POST /models/{name}/move-files` | 移动模型文件，不改命名空间 |
| `GET /namespaces` | 命名空间列表与各自占用 |
| `POST /namespaces` | 新建命名空间 |
| `PATCH /namespaces/{name}` | 重命名命名空间 |
| `DELETE /namespaces/{name}` | 删除命名空间，需先清空 |
| `GET /runtime/status` | 当前运行状态，可带 `?busy=1` |
| `GET /runs` | 运行历史，可带 `?limit=` |

`move` 与 `move-files` 是两件事：前者只改分组标签，后者只搬文件，不要混用。

### 下载与仓库档案

| 方法与路径 | 说明 |
| --- | --- |
| `GET /downloads` | 当前任务与最近历史 |
| `POST /downloads/direct` | 提交 URL 直链下载 |
| `DELETE /downloads/history` | 清除已结束的下载记录（已完成 / 失败 / 取消），不影响进行中的任务与磁盘文件 |
| `POST /downloads/resume` | 恢复整个下载队列 |
| `GET /downloads/stream` | 进度流（SSE，每秒一次全量快照） |
| `POST /downloads/{id}/pause` | 暂停单个任务 |
| `POST /downloads/{id}/resume` | 继续单个任务 |
| `POST /downloads/{id}/cancel` | 取消单个任务 |
| `POST /downloads/{id}/retry` | 重试失败的任务 |
| `GET /repos` | 仓库档案列表 |
| `POST /repos` | 登记一份仓库档案 |
| `POST /repos/probe` | 探测仓库内容，不登记 |
| `DELETE /repos/{id}` | 删除档案，可选是否连带删除文件 |
| `GET /repos/{id}/files` | 档案内的量化分组与本地状态 |
| `POST /repos/{id}/download` | 按量化分组提交下载 |
| `POST /repos/{id}/move` | 更换档案的存放位置 |
| `POST /repos/{id}/repair` | 重建档案目录 |
| `GET /hf/repos/{id}/files` | 直接读取 Hugging Face 仓库的文件清单 |

### 文件与目录

| 方法与路径 | 说明 |
| --- | --- |
| `GET /files/tree` | 模型库目录树与每个文件的引用数 |
| `GET /files/refs` | 查询某个文件被哪些模型引用 |
| `DELETE /files` | 删除文件，支持通配符整组删 |
| `POST /files/bulk-delete` | 批量删除，单项失败不中断整批 |
| `POST /files/move` | 移动文件到已存在的目录 |
| `POST /files/rename` | 文件改名 |
| `GET /folders` | 目录列表 |
| `POST /folders` | 新建目录 |
| `POST /folders/rename` | 目录改名 |
| `GET /disk` | 磁盘占用汇总 |
| `GET /file-meta` | 文件元信息列表（量化标签、备注、哈希） |
| `PUT /file-meta` | 编辑量化标签与备注 |
| `POST /file-meta/checksum` | 后台计算文件完整哈希 |
| `POST /file-meta/locate` | 为一条元信息寻找候选的物理文件 |
| `POST /file-meta/relink` | 确认重新链接到某个候选文件 |
| `DELETE /file-meta/orphans` | 清理物理文件已不存在的元信息记录 |

### 监控、事件与诊断

| 方法与路径 | 说明 |
| --- | --- |
| `GET /container/stats` | 容器 CPU、内存与推理指标当前读数 |
| `GET /gpu/stats` | 显存、利用率、温度 |
| `GET /host/stats` | 宿主机 CPU、内存、1 分钟负载、磁盘剩余与读写 IO、网络收发 |
| `GET /metrics/window` | 历史曲线，`range` 取 `30m`/`2h`/`24h`/`7d` |
| `GET /events` | 操作事件历史，支持 `?limit=`（默认 20、上限 100）与 `?kind=`（精确匹配事件类型） |
| `GET /events/stream` | 事件实时订阅（SSE） |
| `GET /logs/stream` | 运行中模型的容器日志（SSE） |
| `GET /doctor` | 环境自检 |

### 设置与配置

| 方法与路径 | 说明 |
| --- | --- |
| `GET /settings/{key}` | 读取设置项 |
| `PUT /settings/{key}` | 写入设置项，可写的键有 `default_config`、`auto_snapshot`、`onboarding_playground_seen` |
| `GET /settings/hf` | 下载源与出站代理配置（凭据只显示后 4 位） |
| `PUT /settings/hf` | 修改下载源与代理，即时生效 |
| `POST /settings/hf/test` | 用当前配置向 Hugging Face 发起一次真实请求验证连通性 |
| `GET /settings/host-net` | 网络监控网卡设置 |
| `PUT /settings/host-net` | 切换监控网卡 |
| `GET /settings/locale` | 当前界面语言 |
| `POST /settings/locale` | 切换界面语言 |
| `GET /settings/webhooks` | Webhook 渠道配置 |
| `PUT /settings/webhooks` | 整体替换渠道配置 |
| `POST /settings/webhooks/test` | 向指定渠道发一条测试推送 |
| `POST /export` | 导出配置，带 `?model=` 导出单个模型 |
| `POST /import` | 导入配置 |
| `POST /import/preview` | 导入预检，不写入 |
| `POST /migrate/bash` | 从 bash 版 llama-launcher 批量迁移 |
| `GET /images` | 可用与已拉取的 llama.cpp 镜像 |
| `POST /images/pull` | 拉取镜像（SSE 返回进度） |
| `DELETE /images` | 删除本地镜像，当前生效的镜像禁止删除 |

### 推理中转

| 方法与路径 | 说明 |
| --- | --- |
| `/proxy/llama/*` | 转发到当前运行模型的推理接口，见[推理接口](./inference.md) |
