# README 推荐参数的 LLM 解析（批 3）

> 2026-09-03 · 状态：设计定稿，待实施
> 前置：`docs/_internal/features/2026-09-02-HF-README与推荐参数-design.md`（批 1/2 已实施）
> 本文只写批 3。批 1/2 的规则抽取器、推荐卡、参数预设子系统均已上线，不在此重复。

## 1. 为什么要有这一批

规则抽取器在 12 个真实仓库上误报 0、漏抽 0，但它有一条设计上就放弃的形态：**纯散文**。

DeepSeek-R1 官方卡整篇没有一处机器可读的 `k=v`，只有一句

> Set the temperature within the range of 0.5-0.7 (0.6 is recommended) to prevent endless repetitions.

规则引擎在这里必然交白卷，而这恰恰是绝对主流、最该被推荐的模型。这一批就是为这句话存在的。

**边界只有一句：只抠原文里写过的数值，不做推荐、不做硬件适配、不"帮你调参"。** 越出这条线
就无法回证，也就无法让用户信任。

## 2. 已拍板的决策

设计过程中逐条确认过，实施时不再回头议：

| # | 决策 | 取舍理由 |
|---|---|---|
| D1 | **两个引擎一次做齐**（本地 + 外部 API） | 本地零成本、数据不出内网；外部可控可测。缺一个都会让某类用户完全用不上 |
| D2 | **AI 结果与规则结果分列存储**，重跑先预览再决定覆盖 | 规则引擎 bump 版本不该冲掉用户花钱换来的 AI 结果；反之亦然 |
| D3 | **首次直接落库，重跑才弹对比** | 首次没有可对比的东西，弹层只是多一次点击 |
| D4 | **回证 = 数值等值 + 原样字符串双通道**，不做单位换算 | 吃得下 `0.60`↔`0.6`、`32,768`↔`32768`；`32k`→`32768` 属于"解释"，且到底是 32000 还是 32768 从文本判不出来 |
| D5 | **只标注命中原文句，不做滚动定位高亮** | 命中句是回证的副产品，白拿；滚动定位要给渲染后的 markdown DOM 建"原文偏移→节点"映射，是一块独立的活 |
| D6 | **流式（SSE）边生成边显示** | 本地 27B 生成 JSON 可能几十秒，干等没有反馈 |
| D7 | **规则与 AI 签名冲突时规则优先** | 确定性来源胜过生成结果 |
| D8 | **README 变更后不删旧 AI 结果，只标过期** | 花钱换来的东西不替用户丢 |
| D9 | **AI 结果进推荐卡、用 tab 与规则结果切换**，不与规则卡混排 | 规则是零成本即时的，AI 是主动花代价换的，混排会模糊这个区别 |

D9 覆盖了前置设计文档 §9.4 的"混排"表述，实施后需回写那份文档。

## 3. 数据：`repo_readme` 加五列（迁移 v16）

```sql
ALTER TABLE repo_readme ADD COLUMN llm_profiles TEXT;      -- RecommendedProfile[] JSON
ALTER TABLE repo_readme ADD COLUMN llm_engine TEXT;        -- 'local' | 'external'
ALTER TABLE repo_readme ADD COLUMN llm_model TEXT;         -- 实际用的模型 id，卡头要显示
ALTER TABLE repo_readme ADD COLUMN llm_content_sha TEXT;   -- 解析当时的 README sha
ALTER TABLE repo_readme ADD COLUMN llm_parsed_at INTEGER;
```

纯追加列，旧代码忽略新列即可回滚，与 v13/v14/v15 的"只 CREATE、不改既有表"同一条纪律。

`llm_content_sha` 与当前 `content_sha` 不一致时**不删结果**，只在卡头标
「README 已更新，这份 AI 结果基于旧版本」（D8）。

**`profilesEngine` 的单值矛盾就此消掉**：前置设计 §4 把它定义成
`"rules" | "local" | "external"` 单值枚举，但三引擎语义是叠加而非互斥。
接口不再回单一引擎名，两列各自解析后合并成一个数组，每条 profile 靠自带的
`source`（`cli-block` / `kv-list` / `llm`，已存在于类型定义）区分。

## 4. 回证：`src/lib/readme-verify.ts`（承重墙）

LLM 抽取的唯一可信性来源。**每个字段的值必须能在 README 原文里命中，否则丢弃该字段。**

双通道，都不做单位换算（D4）：

- **数值字段** — 把 README 正文扫成数字 token（`/-?\d+(?:,\d{3})*(?:\.\d+)?/g`，剥千分位逗号），
  与 AI 给的值做数值相等比较。吃得下 `0.60`↔`0.6`、`32,768`↔`32768`、`1.0`↔`1`
- **字符串 / 布尔字段** — 归一化（小写、剥引号、去首尾空白）后原样 `includes`

命中即记下**命中所在的那一句**：按行切再按句末标点（`。！？.!?`）切，取含该 token 的最短片段，
硬上限 200 字符（与既有 `excerpt` 同口径）。

未命中 → 丢弃该字段并计数。UI 如实显示「AI 给了 4 个值，2 个无法在原文中回证，已丢弃」。
**这个计数不是调试信息，是让用户敢信任的凭据**，不许省略。

纯函数、无 IO，是本批测试密度最高的地方。

## 5. 引擎：`src/server/llm/`

```
engine.ts    ExtractEngine 接口 + 公共骨架（候选片段 → 流式调用 → 解析 → 回证 → profiles）
local.ts     本地：getRunningContainerInfo 拿 host:port 直连容器，不经浏览器反代
external.ts  外部：OpenAI 兼容 chat completions，走 makeProxyFetch（复用既有出站代理）
prompt.ts    提示词 + JSON schema
settings.ts  引擎选择与外部凭据读写
```

接口刻意**不含 `rules`**（前置设计 §9 的草稿里有）：规则引擎是同步纯函数，既不流式也不会失败，
为它包一层 AsyncIterable 只是让调用方多一条无意义的分支。

```ts
interface ExtractEngine {
  id: "local" | "external";
  /** 流式产出原始文本增量；调用方负责累积、解析、回证 */
  stream(input: { text: string; signal: AbortSignal }): AsyncIterable<string>;
}
```

**输出约束三档回退**：`response_format: json_schema` → `json_object` → 纯 prompt 约束。
当前机器上没有模型在跑，**llama-server 对前两档的支持度未实测**，所以做成探测式降级而不是
硬依赖——降级不报错，后面有回证闸门兜底。（照 `llamacpp-source-vs-image-skew` 那条教训：
参数是否存在一律以镜像实测为准，不以源码为准。）

**候选片段切分** `src/lib/readme-candidates.ts`：按段落打分（含 `temperature` / `top_p` /
`top_k` / `min_p` / `penalty` / `ctx` / `recommend` / 「推荐」「参数」等关键词的优先），
预算 6000 字符（≈1.5k token），按分取、按原文序拼回，超预算标 `truncated`。
不喂整篇 README——`ctx_size` 配小了必然截断，且长上下文让模型更容易发散。

**宽松 JSON 提取** `src/lib/llm-json.ts`：剥 ```` ```json ```` 围栏、忽略前后废话、
取首个平衡的 `{}`。模型吐不出合法 JSON 时返回 null 而非抛错。

## 6. 配置：env 双源 + 设置页

外部凭据照 `HF_TOKEN` 现成的双源模式，**不新造一套**：

| 来源 | 优先级 | 面板可改 |
|---|---|---|
| `PANEL_LLM_BASE_URL` / `PANEL_LLM_API_KEY` / `PANEL_LLM_MODEL` | 高 | 否（只读，显示"来自环境变量"并禁用输入框） |
| `settings` 表（`llm_engine` / `llm_base_url` / `llm_api_key` / `llm_model` 四个键） | 低 | 是 |

已落地（本批开工前完成）：`deploy/.env` 占位、`deploy/.env.example` 注释段、
`deploy/docker-compose.yml` 的 `environment` 透传（`${VAR:-}` 空默认，未配置不报错）。
**不新开凭据表**：`settings` 表已有 `outbound_proxy` 存带密码的代理 URL 的先例，
四个键放同一张表即可，`hf_token` 那张独立表是 M2 的历史形态，不作为新增时的样板。
API Key 永不回显明文，只回尾 4 位——回显逻辑与 `hf/settings.ts` 的 `effectiveToken` 逐字同构。

**设置页新增第 9 张卡** `llm-card.tsx`：

```
解析引擎   ○ 不用（只用规则）    ○ 本地模型    ○ 外部 API
──────────────────────────────────────────────────────
外部 API：Base URL  [https://api.example.com/v1        ]
          API Key   [已保存 ····a3f9]  [更换]  [清除]
          模型      [gpt-4o-mini                       ]
                                              [测试连接]
本地模型：使用当前运行中的模型
          ⚠ 当前没有模型在运行 —— 启动任一模型后可用
```

「测试连接」照 `settings/hf-card.tsx` 现成形态。**本地引擎不可用时灰掉并直说原因**，
不让用户点了才失败。

## 7. 接口

```
POST /api/v1/repos/:id/readme/llm       SSE：token 增量 → 末帧带结果 + hadPrevious
POST /api/v1/repos/:id/readme/llm/save  重跑后点「覆盖」才调
GET|PUT /api/v1/settings/llm            引擎选择 + 外部凭据
POST    /api/v1/settings/llm/test       测试连接
```

`hadPrevious === false` 时服务端在流结束当场落库（D3）；为真则不落库，把结果交给前端弹对比层。

流式解析复用现成的 `LineSplitter` + `parseSseLine`（Playground 同款）；前端照 Playground 的
fetch-reader 形态，**不用 EventSource**——需要 POST 传参。

## 8. UI

### 8.1 整体布局

侧栏 `?view=readme|files` 不动。内容区：

```
┌ license MIT · base_model Qwen3 ────────── 更新于 09-03 10:12 [刷新] ┐
└─────────────────────────────────────────────────────────────────────┘

┌ 模型权重 ─────────────────────────────────── [☐ 下次不再显示 README] ┐
│  Q4_K_M   Q5_K_M   Q6_K   Q8_0   BF16                      [更多 →] │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│  推荐模型配置   [README解析(2)][AI解析(1)]    不满意？用 LLM 解析 ↗ │
│ ───────────────────────────────────────────────────────────────────  │
│   ┌─ Thinking Mode ──────┐  ┌─ Instruct ───────────┐                │
│   │ README 推荐段        │  │ README 推荐段        │                │
│   │ ☑ temp    0.8 → 0.6  │  │ ☑ temp    0.8 → 0.7  │                │
│   │ ☑ top_p   0.9 → 0.95 │  │ ☑ top_p   0.9 → 0.8  │                │
│   │ ☐ ctx_size  → 204800 │  │ ▸ 出处               │                │
│   ├──────────────────────┤  ├──────────────────────┤                │
│   │ [应用到建配置][存预设]│  │ [应用到建配置][存预设]│                │
│   └──────────────────────┘  └──────────────────────┘                │
└─────────────────────────────────────────────────────────────────────┘

┌ README 正文 ────────────────────────────────────────────────────────┐
│  # Qwen3.8-27B-GGUF                                                  │
└─────────────────────────────────────────────────────────────────────┘
```

**正文那块不加 tab**，保持现在的单卡形态。

### 8.2 卡头三态

```
规则 2 套 + AI 1 套
│  推荐模型配置   [README解析(2)][AI解析(1)]    不满意？用 LLM 解析 ↗ │

规则 0 套（README解析 tab 直接不出现；右上角链接也隐藏——已经在 AI tab 上了）
│  推荐模型配置   [AI解析]                                            │

规则 2 套 + AI 没跑过（AI tab 不带计数）
│  推荐模型配置   [README解析(2)][AI解析]       不满意？用 LLM 解析 ↗ │
```

规则：**tab 只在有结果时显示计数**（AI 跑完是 0 套时同样不带数字）；
**默认选中项** = 有规则结果就落 README解析，没有就落 AI解析；
**整张卡在有 README 时总是渲染**——现在的代码是 `profiles.length > 0` 才渲染，
必须改掉，否则最需要 AI 的 0 套场景恰好没有入口。

### 8.3 AI 解析 tab 的四种状态

```
未跑过 ──────────────────────────────────────────────────
│    用 gpt-4o-mini 把 README 里散文写的参数抠出来。      │
│    只抠原文里写过的数值，抠不出的一律丢弃。约 10-30 秒。│
│                              [ 开始解析 ]               │

解析中 ──────────────────────────────────────────────────
│  ┌ 等宽滚动区，自动滚底 ──────────────────────────────┐ │
│  │ {"profiles":[{"label":"Recommended","server":{"te  │ │
│  │ mp":0.6,"top_p":0.95                              ▌│ │
│  └────────────────────────────────────────────────────┘ │
│                              [ 取消 ]                    │

有结果 ──────────────────────────────────────────────────
│   ┌─ Recommended settings ───────────┐                   │
│   │ AI 解析 · gpt-4o-mini · 10:31    │                   │
│   │ ☑ temp   0.8 → 0.6   ▸ 原文      │                   │
│   │ ☑ top_p  0.9 → 0.95  ▸ 原文      │                   │
│   ├──────────────────────────────────┤                   │
│   │ [应用到建配置][存预设]           │                   │
│   └──────────────────────────────────┘                   │
│   AI 给了 4 个值，2 个无法在原文中回证，已丢弃           │
│                          [ 重新解析 ]                    │

不可用 ──────────────────────────────────────────────────
│    ⚠ 选了「本地模型」但当前没有模型在运行               │
│      启动任一模型后可用            [ 去设置 ]           │
```

「▸ 原文」展开是等宽的命中句（200 字符封顶）：

```
   ☑ temp  0.8 → 0.6   ▾ 原文
      "Set the temperature within the range of 0.5-0.7 (0.6 is
       recommended) to prevent endless repetitions."
```

**不可用的三种原因分别直说**：设置里选了「不用」／选了外部但三项没配齐（带跳设置页链接）／
选了本地但当前没有模型在跑。都不给按钮。

### 8.4 入口行为

点右上角「不满意？用 LLM 解析」= 切到 AI tab；**若引擎可用且从没跑过，顺手自动开跑**
（点这个链接的意图已经足够明确）；已有结果则只切过去不重跑——重跑要显式点，会弹覆盖对比。

### 8.5 tab 状态不进 URL

就是组件内 state。侧栏 `?view=` 已经占了一级，再叠一个只为阅读态的参数不值当；
入口链接是同组件内回调，不需要 URL 中转。

判定下沉 `src/lib/recommend-tabs.ts`（哪些 tab 出现、默认选谁、计数怎么显示），
与 `logs-tabs.ts` / `settings-tabs.ts` 同形态，纯函数可单测。

## 9. 一个可接受的失败模式

本地挂 1.5B 小模型时它很可能吐不出合法 JSON，或吐出一堆没法回证的数。回证闸门会把这些
全丢光，结果是「AI 也没找到」而不是错结果。

UI 措辞必须区分两件事：

- **「AI 没找到推荐参数」** —— 跑通了，但原文里确实没有可抠的
- **「AI 输出无法解析，换个大一点的模型试试」** —— `llm-json.ts` 返回 null

把后者说成前者，用户会以为这个仓库没参数；说成故障，用户会反复重试烧额度。

## 10. 测试

| 文件 | 覆盖 |
|---|---|
| `lib/readme-verify.test.ts` | 双通道回证、命中句定位、丢弃计数（**本批重头**） |
| `lib/readme-candidates.test.ts` | 段落打分、预算截断、原文序还原 |
| `lib/llm-json.test.ts` | 围栏剥离、前后废话、截断 JSON、非法输入返回 null |
| `lib/llm-profiles.test.ts` | 原始输出 → RecommendedProfile[]，source/extras/丢弃计数 |
| `lib/recommend-tabs.test.ts` | tab 出现条件、默认选中、计数显示 |
| `server/llm/extract.test.ts` | 编排（注入假引擎） |
| `server/llm/external.test.ts` | 请求形状、错误分类、代理生效 |
| `server/llm/local.test.ts` | 注入 getRunningContainerInfo + fetch，无模型时的拒绝路径 |
| `server/llm/settings.test.ts` | env/db 双源优先级、尾 4 位、清除 |
| `server/hf/readme.test.ts` | 增量：新列读写、sha 过期标记、两列合并去重 |

预估 +120~150 用例。组件按项目惯例不单测（vitest 是 node 环境、无 jsdom），
可测判定一律下沉 `src/lib/*.ts`，组件靠 eslint + `tsc --noEmit` + `next build` 守。

中英文案两侧对称检查照旧。

## 11. 明确不做

- **滚动定位高亮**（D5）——只标注命中句
- **后台任务队列**——手动触发、几十秒就完的操作，引入任务状态表是过度工程
- **多套外部凭据**——一套够用，YAGNI
- **自动触发**——一半的仓库根本没有推荐参数，自动跑就是对着 bartowski 的 README 白烧额度
- **AI 参与「应用到建配置」以外的任何自动行为**
- **单位换算**（D4）

## 12. 风险

1. **llama-server 的 `response_format` 支持度未实测**（当前无模型在跑）。三档回退是为此设计的，
   但本地引擎的真机验收必须实跑一次，不能只靠单测过关。
2. **本地引擎占用正在运行的模型一次推理**，与 Playground 抢槽位。按钮旁需明示。
3. **外部 API 的额度消耗**由手动触发 + 候选片段裁剪双重约束，但没有硬性上限——
   若真机验收发现单次消耗超预期，再议是否加每日次数限制（不预先实现）。
