# 配置格式与迁移

面板的配置存在数据库里，YAML 是它的导出格式。这一篇讲这份 YAML 长什么样、各字段是什么意思，以及怎么从 bash 版 llama-launcher 迁过来。

## 这份文件从哪来

有三个途径拿到它：

- **自动快照**——设置页打开自动快照后，每次配置变更都会把全量配置写进 `data/export/latest.yaml`。这是最省事的备份方式，把这个目录纳入 git 就有了带历史的配置记录。
- **导出全集**——设置页的「导出全集」按钮打包一个 zip 放在 `data/export/` 下，里面是一份 `llamapad.yaml` 加每个模型各自一份 YAML。
- **导出单个模型**——只有接口提供，界面上没有入口。适合分享单个模型的配置或在两台机器之间搬一个模型，用法见[面板 API](./api.md)。

**这些文件都是导出物，改它们不会影响面板。** 想让改动生效，要走设置页的导入功能把改好的内容导回去。直接编辑 `latest.yaml` 只会在下一次配置变更时被覆盖掉。

## 文件结构

```yaml
default_config:
  docker:
    image: ghcr.io/ggml-org/llama.cpp:server-cuda
    container_name: llama-server
    model_volume: /srv/llama/models:/models
    host_port: 18080
    container_port: 8080
    gpu: all
  server:
    host: 0.0.0.0
    ctx_size: 131072
    gpu_layers: 99
    flash_attention: on
    batch_size: 4096
    ubatch_size: 1024
    cont_batching: true
    cache_type_k: q4_0
    cache_type_v: q4_0
    enable_thinking: false
    repeat_penalty: 1
    presence_penalty: 1.5
    min_p: 0
    top_k: 20
    top_p: 0.8
    temp: 0.7
    reasoning_effort: inherit
  api:
    effort_aliases: {}
    effort_rounding: down
models:
  - name: qwen3-30b
    display_name: Qwen3 30B
    namespace: main
    gguf_file: main/Qwen3-30B-Q4_K_M.gguf
    overrides:
      server:
        ctx_size: 32768
namespaces:
  - main
repos:
  - repo: unsloth/Qwen3-30B-GGUF
    baseDir: hf
presets:
  - name: 长文本保守
    description: 384K 长上下文场景，牺牲一些吞吐换稳定
    server:
      ctx_size: 393216
      temp: 0.6
      top_p: 0.95
```

五个顶层段：`default_config` 是全局默认参数，`models` 是模型配置列表，`namespaces` 是命名空间名单，`repos` 是仓库档案的登记信息，`presets` 是可复用的参数预设列表。

`repos` 段和 `presets` 段都只出现在全量导出里；导出单个模型时没有这两段。

## default_config

### docker 段

| 字段 | 取值 | 说明 |
| --- | --- | --- |
| `image` | 镜像引用 | 用哪个 llama.cpp 镜像 |
| `container_name` | 字母数字开头，可含 `_.-` | 模型容器的名字 |
| `model_volume` | `宿主机路径:容器内路径` | 模型库怎么挂进容器。**写在 `default_config` 这一层不生效**（见下方说明），只有写进某个模型的 `overrides.docker` 才会被逐字使用 |
| `host_port` | 1–65535 | 模型服务发布到宿主机的端口 |
| `container_port` | 1–65535 | 容器内监听的端口 |
| `gpu` | `all` / `none` / `device=0,1` | 用哪些显卡 |

以下几个是给自定义镜像准备的，官方镜像用不到，不写就是不启用：

| 字段 | 取值 | 说明 |
| --- | --- | --- |
| `model_mount` | 路径 | 容器内的模型挂载点。不写时固定用 `/models`，**不会跟着 `model_volume` 变**——若用 overrides 把 `model_volume` 的容器侧路径改成了别的值，必须同时把 `model_mount` 改成一致，否则模型路径参数仍指向 `/models`，容器起得来但找不到文件 |
| `entrypoint` | 字符串数组 | 覆盖镜像自带的 entrypoint |
| `extra_args` | 字符串数组 | 在自动生成的参数之后追加 |
| `args_override` | 字符串数组 | 完全取代自动生成的参数 |
| `env` | `KEY=value` 数组 | 额外的环境变量 |

`extra_args` 与 `args_override` 是二选一的关系：前者是追加，后者是整体替换。

**关于 `model_volume`**：这个字段在 `default_config` 这一层是必填的（schema 要求它存在且格式合法），但面板启动模型时并不读它——模型库挂进容器用的宿主机路径来自环境变量 `PANEL_MODELS_HOST`、`panel.yaml` 的 `paths.models.host`，或者由面板自动发现，设置页也没有编辑它的入口。改这里的值不会改变任何挂载行为。只有写进某个模型的 `overrides.docker.model_volume` 时，它才会被逐字用作该模型容器的挂载参数。

### server 段

这一段对应 llama-server 的启动参数。

| 字段 | 取值 | 说明 |
| --- | --- | --- |
| `host` | 监听地址 | 通常是 `0.0.0.0` |
| `ctx_size` | ≥0 整数 | 上下文长度，影响显存占用 |
| `gpu_layers` | ≥0 整数 | 放到显卡上的层数，`99` 表示尽量全放 |
| `split_mode` | `none` / `layer` / `row` / `tensor` | 多卡切分方式；不填则跟随 llama.cpp 默认。`row` 已被上游弃用 |
| `tensor_split` | 逗号分隔数值 | 各卡显存分配比例，如 `3,1`；顺序是容器内卡序 |
| `main_gpu` | ≥0 整数 | 主卡编号，从 0 开始；编号是容器内序号，不是宿主机 GPU 编号 |
| `flash_attention` | `on` / `off` | 注意是这两个字符串，不是 `true` / `false` |
| `batch_size` | ≥1 整数 | 批大小 |
| `ubatch_size` | ≥1 整数 | 微批大小 |
| `cont_batching` | 布尔 | 连续批处理 |
| `cache_type_k` | 见下 | K 缓存的量化类型 |
| `cache_type_v` | 见下 | V 缓存的量化类型 |
| `enable_thinking` | 布尔 | 是否启用思考模式 |
| `repeat_penalty` | 0–2 | 重复惩罚 |
| `presence_penalty` | -2–2 | 存在惩罚 |
| `min_p` | 0–1 | 最小概率阈值 |
| `top_k` | ≥0 整数 | 候选词数量 |
| `top_p` | 0–1 | 累积概率阈值 |
| `temp` | 0–2 | 温度 |
| `reasoning_effort` | 见下 | 思考强度 |

`cache_type_k` 与 `cache_type_v` 的可选值：`f16`、`q8_0`、`q4_0`、`q4_k`、`q5_0`、`q5_k`、`q6_k`、`q8_k`。缓存量化得越狠越省显存，长上下文时效果明显。

`reasoning_effort` 的可选值：`inherit`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`。`inherit` 表示跟随模型对话模板自己的默认值，不去干预——这也是默认值。要注意的是，这个参数是否有效取决于模型的对话模板读不读它，与模型名字无关。

> **编号的坐标系**：`docker.gpu` 里 `device=1,2` 写的是**宿主机**显卡编号，但容器内的卡会
> 重新从 0 编号——上例中宿主机 GPU1 在容器里是 0 号。`main_gpu` 与 `tensor_split` 的顺序
> 吃的是容器内编号。面板在编辑页会给出对照说明，手写 YAML 时要自己换算。

### api 段

这一段管的是面板作为推理中转时的改写行为，不是 llama-server 的启动参数。

`effort_aliases` 是思考强度的别名表，一组字符串到字符串的映射，例如把客户端发来的 `high` 换成 `xhigh`。`effort_rounding` 决定客户端发来的值超出模型支持范围时怎么办：`down` 向下取最接近的档位，`up` 向上取，`off` 直接丢弃这个字段、让模板走自己的默认值。

详细规则见[推理接口](./inference.md)的思考强度中转映射一节。

## models

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `name` | 是 | 模型 id，只允许小写字母、数字和连字符，全局唯一 |
| `display_name` | 是 | 界面上显示的名字，没有字符限制 |
| `namespace` | 否 | 所属命名空间，默认 `main` |
| `gguf_file` | 是 | 相对模型库根目录的路径，必须以 `.gguf` 结尾；分片模型写 glob |
| `mmproj_file` | 否 | 多模态投影文件的路径 |
| `download` | 否 | 这个模型是从哪下载来的，见下 |
| `overrides` | 否 | 该模型对全局默认参数的覆盖 |

`gguf_file` 与 `mmproj_file` 都是**相对模型库根目录**的路径，不能写绝对路径。分片模型写成 glob，通配符要替换掉整段序号尾缀，例如 `main/Qwen3-235B-A22B-Q4_K_M-*.gguf`。把通配符放在序号段前面、序号本身写死是错的，那样只会匹配到第一片。

`download` 记录来源，两种形式：

```yaml
download:
  source: hf
  repo: unsloth/Qwen3-30B-GGUF
  file: Q4_K_M/Qwen3-30B-Q4_K_M.gguf
  sha256: <64 位小写 hex，可选>
```

```yaml
download:
  source: url
  url: https://example.com/model.gguf
  file: model.gguf
  sha256: <可选>
```

`overrides` 的结构与 `default_config` 相同，但每一段、每个字段都是可选的——只写你要改的那几个：

```yaml
overrides:
  server:
    ctx_size: 32768
    temp: 0.3
  docker:
    host_port: 18081
```

没写的字段跟随全局默认值变化——改一次全局默认，所有没单独覆盖过这一项的模型都会跟着变。

**`overrides` 里不允许出现未知字段。** 写错一个字段名不会被静默忽略，导入时会直接报错并指出是哪个字段——这样拼错的参数不会悄悄失效。

## namespaces 与 repos

`namespaces` 是命名空间名字的列表，只允许小写字母、数字、点、下划线和连字符。

`repos` 是仓库档案的登记信息，每项两个字段：`repo` 是 Hugging Face 仓库 id，`baseDir` 是档案目录相对模型库根的位置（空字符串表示根目录本身）。导入时会按这些信息重建档案目录，让已经下载过的文件被重新认领，不用重下。

## presets

「参数预设」是一组不绑定任何模型的、有名字的参数覆盖，管理入口见[设置项详解](./settings.md)的「模型库」一节，用法见[模型管理](./models.md)与[文件与命名空间](./files.md)。每项三个字段：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `name` | 是 | 预设名，同一份导出内唯一 |
| `description` | 否 | 用途说明 |
| `server` | 是 | 与 `overrides.server` 同一套字段和值域，只写要带的那几个参数，不允许未知字段 |

**面板内置的「保守 / 平衡 / 全卸载」三档快速预设不进导出**——它们跟着代码版本走，不落库。导出物里的 `presets` 只包含用户自己新建、或从 README 推荐参数另存下来的那些；后一种情况在应用内会记来源仓库，但导出时不带这个字段（换机器后来源信息没有意义）。

导入 `presets` 段时同名一律跳过、不覆盖，没有 `models` 段那样改名 / 覆盖的选项——导入不该悄悄改掉一份你已经在用的预设。单条解析失败不会阻断整批导入，结果里会分别列出新建、跳过与失败的名字。

## 手工编辑与导入

想批量改配置（比如给二十个模型统一调上下文长度），比在界面上逐个点更快的做法是：导出 → 编辑 YAML → 导入。

导入在设置页的「导入」入口，粘贴 YAML 全文即可。有三个要点：

**格式要选对。** 本产品导出的选 `llamapad`，bash 版 llama-launcher 的配置选 `bash`。面板不会自动识别，选错了会报解析错误。

**同名模型的处理方式有三种。** 跳过（保留现有的）、改名导入（加 `-1` 后缀）、覆盖（用导入的替换现有的）。

**导入前会做一次预检。** 面板会检查每个模型引用的 GGUF 文件在本机存不存在。有缺失的会列出来，让你为每一行手动指定一个本机已有的文件顶替。不指定也可以，那一行就按原路径导入——模型照样建出来，只是文件处于缺失状态，之后在文件页补上或改路径都行。跨机迁移时这一步很有用，两台机器的目录结构往往不一样。

## 从 llama-launcher 迁移

bash 版的配置目录里通常是一个 `default.yaml` 加若干个模型 YAML。设置页的迁移入口支持一次提交多个文件，面板按文件名区分：`default.yaml` 当作全局默认配置解析，其余当作单个模型。

迁移时会做这些转换：

- **模型统一落到 `main` 命名空间**——bash 版没有命名空间这个概念。
- **文件路径自动补前缀**——原来写的是裸文件名（不含 `/`）时会补成 `main/文件名`；已经带目录的保持原样。
- **GPU 字段换名**——bash 版的 `docker.gpu_devices` 映射到 `gpu`。空值和 `all` 都变成 `all`，`none` 保持 `none`，`0,1` 这样的显卡编号变成 `device=0,1`。
- **不支持的字段会被忽略**——bash 版独有、面板没有对应项的字段（例如 `jinja`、`no_mmap`）不会导致迁移失败，而是列进警告清单里告诉你哪些被丢掉了。
- **缺失的字段用内置默认值补齐**——bash 版的 `default.yaml` 没写全的部分不影响迁移。

**迁移不做文件预检**，这一点和单份 YAML 导入不同——不会给你重指缺失文件的机会，路径原样落库。所以迁移完成后要核对两处：

- 模型页上各模型的 GGUF 文件是否都存在（缺失的会标出来），路径不对的到编辑页改；
- 新机器上的模型库路径是否配好——这个路径来自环境变量 `PANEL_MODELS_HOST` 或 `panel.yaml`，不是 YAML 里的 `model_volume`（那个字段在默认层不生效，见上文）。设置页的环境自检会直接告诉你模型库路径解析成功没有。
