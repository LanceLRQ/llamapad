# 推理接口

## Playground

Chat 页（`/chat`）是面板自建的对话界面。运行中且模型已就绪时才会渲染 Playground；容器已起但还没探活成功时显示加载态，不会让请求打到一个还没准备好的端口上。

面板自建 Playground **不会主动发送任何采样参数**——请求体只有 `messages` 与 `stream` 两个字段。llama.cpp 自带 web UI 的采样参数配置存在 `:18080`（llama-server 自己的端口）那个 origin 的 `localStorage` 里，面板跨源读不到也改不到；面板自己不发采样参数，就从根上绕开了两边配置对不上的问题，模型模板与配置里已经设置好的默认值会照常生效。

页头「打开 llama UI」按钮是 llama.cpp 自带 web UI 的补充入口（新标签页打开，不经面板反代）。目标地址两种来源：

- `panel.yaml` 的 `chat.base_url` 显式配置，优先；
- 未配置时按浏览器当前访问地址推导 `http://<hostname>:<运行模型的宿主机端口>`。

多数场景不需要配置 `chat.base_url`——面板与 llama-server 的端口发布在同一台宿主机，浏览器访问面板用的 hostname 天然也是 llama-server 所在的 hostname。只有当这个外链按钮的目标域启用了 HSTS、导致浏览器把明文 `http://` 地址强升为 `https://` 连接失败时，才需要在 `panel.yaml` 里显式指定一个可达地址。

## 中转接口 `/api/v1/proxy/llama/*`

面板把当前运行容器的 llama-server 接口经同源路径 `/api/v1/proxy/llama/*` 转发出来——这是面板唯一的推理转发入口，Playground 本身也走这条路。它的作用是**把两个端口收敛成一个**：SSH 隧道、反向代理场景只需要暴露面板这一个端口，不必再额外开一个洞给 llama-server。

### 鉴权

- **同源请求**（浏览器里的 Playground）自动带 session cookie，天然可用；
- **脚本 / 外部客户端**用 `Authorization: Bearer lp_…`，token 在「设置 → 账号与安全」签发（明文只在签发那一刻显示一次）。

**注意：`x-api-key` 头不被接受。** 这是 Anthropic 官方 SDK 默认发送凭据的方式（`ANTHROPIC_API_KEY` 环境变量），但面板目前只认 session cookie 或 `Authorization: Bearer`。用 Anthropic 官方 SDK 接入时，需要显式配置它走自定义 `Authorization` 头（如 `ANTHROPIC_AUTH_TOKEN`），或改用支持自定义请求头的客户端。

### 支持的协议

llama.cpp 上游已经原生实现了三套协议入口，面板对这三条路径全部是**透明转发**——不解析、不改写请求体或响应体（唯一的例外见下节「思考强度中转映射」），协议翻译的工作完全在 llama.cpp 内部完成：

| 协议 | 经面板访问的路径 |
| --- | --- |
| OpenAI Chat Completions | `/api/v1/proxy/llama/v1/chat/completions` |
| OpenAI Responses | `/api/v1/proxy/llama/v1/responses` |
| Anthropic Messages | `/api/v1/proxy/llama/v1/messages` |

三者都能直接使用，不需要面板做任何协议转换。需要留意上游成熟度的差异：Responses 协议上游明确不支持 `previous_response_id`（服务端多轮状态）与 `store`，请求这些字段不会报错但也不会生效；Anthropic Messages 协议支持度更完整（工具调用、thinking 块、流式事件都已实测可用），但错误响应体的形状仍是 OpenAI 风格而非 Anthropic 规范形状。

### 流式

请求体与响应体都是原样流式转发，不会被面板攒批——响应逐块到达，不会有等一批凑够了再一次性推给客户端的延迟。

### 单模型语义下 `model` 字段的实际作用

llamapad 同一时刻只运行一个模型，请求体里的 `model` 字段**不参与路由**——不管填什么，请求都会打到当前正在运行的那一个模型上。响应里的 `model` 字段与 `GET /v1/models` 列出的 id 显示的是面板里配置的模型名，而不是容器内的 GGUF 文件路径；但这只影响**回显**，不影响**路由**——用错误的 `model` 值请求同样会成功，只是打到当前运行的模型上。

### 错误形态

响应均为 JSON：

| 场景 | 状态码 | 响应体 |
| --- | --- | --- |
| 没有运行中的模型 | 503 | `{"error":"没有运行中的模型","hint":"/models"}` |
| 容器端口未就绪（启动窗口期常见） | 502 | `{"error":"容器端口未就绪"}` |

502 通常发生在模型刚启动、容器已经在跑但 llama-server 还没开始监听的窗口期，重试即可；这个窗口在大模型冷启动时可能持续数十秒。

## 思考强度中转映射

不同模型打包的 chat template 接受的 `reasoning_effort` 值域不一致（例如某些 Qwen3 系模板只认 `xhigh` / `medium` / `low`），客户端常发的 `high` / `max` / `minimal` 在这些模板上会让 llama-server 直接抛出 HTTP 500——而且容器本身照常启动、健康检查照常通过，只有真正发起一次带这个值的推理请求时才会暴露。为了让客户端发什么值都能正常工作，面板转发请求时会自动改写这个值。

**触发条件**：POST 请求、`Content-Type` 为 `application/json`、路径命中白名单（`v1/chat/completions`、`chat/completions`、`apply-template`）三者同时满足才会改写；`GET` 请求、非 JSON 请求体、白名单之外的路径一律原样透传。

**改写规则**（按顺序判定，命中即停）：

1. 值为 `"none"`：原样透传（llama.cpp 把它当"关闭思考"处理）；
2. 命中该模型 API 配置里的显式别名表：用别名结果；
3. 已在该模型模板支持的值域内：原样透传；
4. 该模型是否支持 `reasoning_effort` 未知（GGUF 未内嵌模板，或模板不读这个变量）：原样透传，没有判断依据时不乱动；
5. 值域外且配置的取整方向为 `off`：丢弃该字段，让模板走自身默认值；
6. 值不在阶梯（`minimal < low < medium < high < xhigh < max`）上：丢弃该字段；
7. 就近取整：按配置的方向（`down`/`up`）在该模型支持的值域内找最接近的档位。

面板判断一个模型支不支持 `reasoning_effort`，依据是 GGUF 内嵌的 chat template 里是否读取 `reasoning_effort` 或 `reasoning_strength` 这两个变量名；判断不出来时按规则 4 原样透传，不做值域校验。

**诊断信息**：发生改写时，响应会带上 `x-llamapad-reasoning-effort` 头，格式形如 `high->xhigh (alias)` 或 `banana->dropped (unsupported)`，客户端原始传入的值与最终决议都能在这个头里看到。

**体积限制**：请求体超过 4MB（或缺少 `content-length` 头、无法安全判断大小）时**跳过改写**，原样转发。跳过时响应头仍会标注 `skipped (body too large)`，避免客户端误以为字段被静默忽略。

**`GET /v1/models` 增强**：面板会给上游返回的 `data[]` 每一项额外注入 `supported_parameters`（是否支持 `reasoning_effort`）与 `x_llamapad.reasoning_effort`（含 `supported` / `levels` / `aliases` / `rounding`），供 Cherry Studio 一类客户端据此判断该模型该发什么值。这是唯一一处面板会缓冲并改写响应体的路径（其余路径响应体全部流式直传）。

模型级别固定的 `reasoning_effort` 配置（区别于本节的"每次请求动态改写"）见[模型配置](./models.md)。

## 已知边界

llama.cpp 自带 web UI 的 `dry_penalty_last_n` 参数若为 `-1`，新版 llama-server 校验要求该值 `≥0`，会导致聊天请求返回 400。这个值存在 llama-server 那个 origin 的 `localStorage` 里，面板跨源改不到，只能在 web UI 自己的设置里手动修改。详见[排错](./troubleshooting.md)。
