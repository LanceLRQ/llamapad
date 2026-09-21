# MTP 支持：开关、权重关联与识别

> 2026-09-21 · 状态：设计定稿，待实现
> 调研底稿：`docs/_internal/research/06-MTP模型支持与权重关联调研.md`（含 2026-09-21 实测补记二）

## 1. 背景

llama.cpp 主线已原生支持 MTP 投机解码（`--spec-type draft-mtp`，部署镜像三个变体全部实测支持），面板侧零实现：用户手上的 MTP 权重既开不了、也关联不上，唯一途径是手写 `extra_args` 并自己拼容器内绝对路径。

2026-09-21 实测四个真实权重后，有两条结论改变了动手前的方向：

1. **主模型可能自带 MTP 头**。`Qwen3.8-27B-UD-Q4_K_XL.gguf` 文件名完全不含 MTP 字样，却带 `blk.64.nextn.*` 张量。即最常见的场景是「主模型已内嵌、只差一个开关」，**开关比关联优先**。
2. **文件名不可信，元数据可信**。名字带 MTP 的可能是主模型（`Native-MTP-Preserved`）、也可能是挂件（`mtp-Qwen3.8-27B-Q4_0`）；名字不带的反而可能内嵌。只有 GGUF 元数据能分清。

## 2. 判据层

### 2.1 实测依据

| 文件 | 大小 | 张量数 | block_count | nextn_predict_layers | 实际是 |
|---|---|---|---|---|---|
| `MTP/mtp-Qwen3.8-27B-Q4_0.gguf` | 1.3G | **18** | 65 | 1 | sidecar |
| `Qwen3.8-27B-UD-Q4_K_XL.gguf` | 16.7G | 866 | 65 | 1 | 内嵌型主模型 |
| `Qwen3.6-35B-A3B-…-Native-MTP-Preserved-Q4_K_M.gguf` | 20.3G | 753 | 41 | 1 | 内嵌型主模型 |
| `Qwen3.8-27B-Heretic-Q4_K_M.gguf` | 15.4G | 851 | 64 | **无** | 普通模型 |

`sidecar` 的 `block_count` 与主模型**完全一样**（65），`general.name` 也同叫 `Qwen3.8-27B`、`general.type` 同为 `model`——只有张量数暴露了它装不下 65 层。**分界是张量数，不是 block_count。**

### 2.2 判定规则

新增纯函数 `src/lib/mtp-kind.ts`：

```
无 <arch>.nextn_predict_layers        → "none"      不提供 MTP 开关
有 nextn + tensorCount/blockCount < 2 → "sidecar"   是挂件，不是独立模型
有 nextn + 否则                        → "embedded"  开关即用，无需关联
```

阈值 2 的含义是「连一层的张量量都不够」。实测两端相差两个数量级（0.28 vs 13～18），阈值取中间极宽松。`blockCount` 为 0 或缺失时不做除法，退化为 `tensorCount < 50` 同款判定。

判定只读 KV 元数据，不下探张量表——后者要扩 `parseGguf` 去解析张量名表，成本高得多。三个实测样本上 KV 键与张量表一致；调研 §三 记的 `Qwen-AgentWorld` 反例（声明了 MTP 但张量被丢弃）说明存在不一致的可能，届时表现为「开关可见但启动失败」，由 llama.cpp 报错兜底，不值得为此提前付出解析张量表的代价。

### 2.3 解析器改动

两处极小改动，解析器主体不动：

- `src/core/gguf.ts:229` —— `tensor_count` 当前读了就扔（注释原话「张量表在 KV 段之后，本函数不解析，读满宽度即可推进」），改为保留进 `GgufMeta`；
- `GGUF_INTEREST`（`gguf.ts:59`）加 `nextnPredictLayersSuffix: ".nextn_predict_layers"`，与既有 `.block_count` / `.context_length` 完全同款的「架构前缀 + 后缀键」形态。

`gguf_meta` 缓存表（迁移 v6，命中条件 path+size+mtime）现成，不会每次进页面重扫。**`GgufMeta` 结构变化会让旧缓存行缺字段**，需要同步处理缓存失效（见 §7）。

## 3. 配置 Schema

`serverConfigSchema`（`schemas.ts:115`）新增两个字段：

```ts
spec_type: z.enum(["none", "draft-mtp"]).default("none"),
spec_draft_n_max: z.number().int().min(1).max(16).default(2),
```

放 server 段而非 docker 段，与多卡那批 B1 的裁定一致——server 段才能被 `param_presets` 复用。

`modelSchema` 新增（贴着 `mmproj_file`，`schemas.ts:261`）：

```ts
draft_file: ggufPathSchema.optional(),
```

**字段名取 `draft_file` 而非 `mtp_file`**：上游 `-md` 本就是所有 draft 型投机解码的公共入口（调研 §2.3），以后加 GLM 那种 `draft-simple` 只需多一个枚举值，不必改 schema、迁移与 YAML 导出。但本期 `spec_type` 只给两档，UI 只引导选 MTP sidecar——名字宽、功能窄。

`spec_draft_n_max` 默认 **2** 而非上游的 3：调研实测 Qwen3.6-27B 卡 2、Gemma 4 卡 1，深了反而回退。面板给默认值，但不假装它是普适最优（UI 文案要说明这一点）。

## 4. 启动参数

照抄 mmproj 的既有链路：

- `args.ts`（对照 `:129-131` 的 mmproj 分支）：`spec_type !== "none"` 时追加 `--spec-type <v>`，并**恒传** `--spec-draft-n-max`（最优值依硬件，不能靠上游默认）；`draftPath` 有值时追加 `-md <容器内路径>`；
- `runtime.ts`（对照 `:109` 的 `mmprojRel`）：`ResolvedModelPaths` 加 `draftRel`，拼 `${modelMount}/${rel}`；分片 draft 传首分片；
- `images.ts`（对照 `:96-103`）：`args_override` 占位符加 `{{draft_path}}`。

`draft_file` 有值但 `spec_type === "none"` 时不传 `-md`——配置里留着文件但没开开关，属用户暂时关掉，不该偷偷传参。UI 侧给提示（见 §6）。

## 5. 引用一致性（不可后置）

`mmproj_file` 的引用检查是**硬编码字段名**散在多处，加 `draft_file` 必须同步改，否则删掉被引用的 sidecar 不会警告、移动命名空间时路径不会重写，配置静默指向不存在的文件、到启动才炸：

| 位置 | 改动 |
|---|---|
| `fileMeta.ts:283` | `["gguf_file", "mmproj_file"]` 数组加 `"draft_file"` |
| `fileMeta.ts:454` | 逐字段 if 加 `draft_file` 分支 |
| `namespaces.ts:114` | 命名空间文件解析加 `draft_file` |
| `namespaces.ts:215` | 移动时路径前缀重写加 `draft_file` |
| `repoProfiles.ts:397` | 档案移动的引用重写加 `draft_file` |
| `model-form.ts:51,79,126,227` | 草稿字段映射表、草稿类型、读入、写回各加一条 |
| `edit-form.tsx:152` | 提交时的显式 null 处理 |

这批改动没有新逻辑，但**漏一处就是数据一致性缺陷**，实现时要逐条核对。

## 6. UI

### 6.1 编辑页：独立的 MTP 节

`model-params-form.tsx` 现在把「基本信息/Docker/性能/采样」合并成一节「配置」（`:72`）。MTP **单独成一节**而不是并进去——它有三个控件（开关 / 深度 / 文件选择器），比 mmproj 的单一文件选择器重，且需要一句说明文字解释「为什么有的模型开不了」。

节内三项。**判据作用在主 GGUF（`gguf_file`）上**，三种取值各对应一种形态：

| 主 GGUF 判定 | MTP 开关 | 说明文案 |
|---|---|---|
| `embedded` | 可开 | 正常形态：权重自带 MTP 层，开了即用，`draft_file` 留空 |
| `none` | 置灰 | 「该权重不含 MTP 层，无法开启」 |
| `sidecar` | 置灰 + 警告 | 这是**配置错误**：用户把挂件当主模型了，提示「这是 MTP 加速权重，不能作为主模型使用」 |

第三行是自检时改过来的——初稿把 `sidecar` 写成「可开」是错的：sidecar 只有 18 个张量，当主模型必然跑不起来，`§6.2` 正是为了拦住这种选法。它出现在主模型位只说明用户绕过了候选过滤（手填路径或旧配置），该报错而不是给开关。

另外两个控件：

| 控件 | 行为 |
|---|---|
| 草稿深度（`spec_draft_n_max`） | 仅开关打开时可编辑，默认 2，文案说明最优值依硬件、不是普适最优 |
| 加速权重（`draft_file`） | 可选，**候选只列判定为 `sidecar` 的文件**。`embedded` 的模型留空即可；选了但开关没开时提示「已选加速权重但未开启 MTP」 |

判据在 server 侧从 `gguf_meta` 读出后随页面数据下发，不在客户端解析 GGUF——与「思考强度」支持态的既有做法同款（`model-params-form.tsx:267` 的注释写明「page.tsx 用 chatTemplate 判定过一次」），照那个范本走。

### 6.2 sidecar 防误选（修现存缺陷）

sidecar 现在被当成 `kind: "model"`，会进建配置候选——`mtp-Qwen3.8-27B-Q4_0.gguf` 会显示成一个「Q4_0 的模型」，选了就是个 1.3GB 跑不起来的配置。

`batch-create.ts:14-15` 已有现成的排除语义与注释（「mmproj 分组不出现在候选里——它是别的模型的挂件，不是一个独立可创建的模型」），让 sidecar 走同一条路。

### 6.3 下载向导配套勾选

照 `archiveMmprojFile(rows)`（`batch-create.ts:56`）与 `attachMmproj` 勾选（`batch-create-form.tsx`，mmproj 相关共 13 处）同构复制一份 draft 版本：仓库里检出 sidecar 时，在「配套文件」区给一个勾选，勾了就下载并填进 `draft_file`。

**与 §6.2 同批做**：两者改的是同一块候选过滤代码，拆成两期等于把同一个文件拆开改两次。

## 7. 缓存与迁移

`GgufMeta` 新增 `tensorCount` 与 `nextnPredictLayers` 两个字段后，`gguf_meta` 表里的旧缓存行不含这两项。处理方式：缓存读出后若缺新字段（`undefined`）即视为未命中、重新解析并回写。不写 schema 迁移——该表是纯派生缓存，删了会自动重建。

## 8. 测试

- `src/lib/mtp-kind.test.ts`：三类判定 + 边界（blockCount 为 0/缺失时退化到绝对值判定、nextn 为 0 视同无）。用本轮四个实测样本的真实数值做夹具。
- `src/core/gguf.test.ts`：`tensorCount` 与 `nextnPredictLayers` 能被解出（`gguf.testkit.ts` 已有构造 GGUF 字节流的工具，扩它即可）。
- `src/core/args.test.ts`：`spec_type` 三种组合（none / draft-mtp 无 draft_file / draft-mtp 有 draft_file）的参数生成；`draft_file` 有值但 `spec_type=none` 时**不传** `-md`。
- `src/server/fileMeta.test.ts` 等：`draft_file` 参与引用检查与路径重写。
- 组件层无测试（vitest 是 node 环境、无 jsdom），靠 `tsc --noEmit` + eslint + `next build` 守。

## 9. 本期不做

| 项 | 理由 |
|---|---|
| `draft-simple`（GLM 用小模型当 draft） | 枚举加值便宜，但跨仓库分片 draft 的 glob 处理与 vocab 兼容校验不便宜；无实际需求，YAGNI |
| 运行时 acceptance 展示 | 连 MTP 能否跑通都未真机验证，先做观测本末倒置。且数据源并不现成（见下） |
| FastMTP 特殊提示 | 需打过 patch 的 llama.cpp 构建，官方镜像跑不了，罕见场景 |
| 远端（未下载）识别 | 实测可行（HF 支持 Range，取前 2MB 即可判定，与本地结果逐字段一致），但本期用户已手动下好文件，属下一步的下载向导增强 |

**一条要修正的调研记载**：调研 §2.4 与 §四.5 称「`/slots` 的 `speculative` 字段已进面板健康判定链路」——实测**生产代码零消费**，该字段只出现在 `health.test.ts` 的测试夹具里（夹具照抄了真实响应）。所以做运行观测时数据源要新接，不是现成的。

## 10. 已知风险

- **mmproj + MTP 同用是否仍 broken**（调研 §七 待验证项 #2 未闭环）：早期分支上同用会丢失视觉能力，主线是否修复需要真机跑才知道。本期不做互斥拦截，列入真机验收项。
- **面板没有 `-np` / `parallel` 参数**（全库零命中），所以「MTP 与 `-np>1` 互斥」这条在面板内不会被触发，除非用户自己写 `extra_args`。本期不做互斥校验。
- **内嵌型判据可能误判**：若出现「声明了 nextn 但张量被丢弃」的权重（调研反例 `Qwen-AgentWorld`），表现为开关可见但启动失败，由 llama.cpp 的报错兜底。
