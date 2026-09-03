# README 推荐参数的 LLM 解析 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让面板能把 README 里用散文写的推荐参数（`"0.6 is recommended"`）抠成结构化配置，每个值必须能在原文里字面命中，否则丢弃。

**架构：** 规则抽取器（已上线）始终跑；LLM 是用户显式触发的增量补充，结果与规则结果分列存储、在推荐卡里用 tab 切换。两个引擎——本地（走运行中的 llama-server）与外部（OpenAI 兼容 API）——共用一条「候选片段 → 流式调用 → 宽松 JSON 解析 → 字面回证 → profiles」的管线。回证是唯一的可信性闸门。

**技术栈：** Next.js App Router route handlers（SSE）、better-sqlite3、zod、undici ProxyAgent、vitest（node 环境，无 jsdom）。

**规格：** `docs/superpowers/specs/2026-09-03-README-LLM解析-design.md`

---

## 全局约束

这些约束对**每一个**任务生效，实现者必须逐条遵守：

1. **测试环境是 node，没有 jsdom、没有 Testing Library。** 组件写不了单测。可测判定一律下沉到 `src/lib/*.ts`，测试文件与实现同目录并列（`foo.ts` + `foo.test.ts`）。组件靠 `pnpm run lint` + `npx tsc --noEmit` + `pnpm run build` 守。
2. **单文件跑测试是 `pnpm vitest run <文件路径>`。** `pnpm test -- <文件>` 不会过滤，会跑全量。
3. **中英文案必须对称**：`src/i18n/messages/zh.json` 与 `en.json` 的键集合完全一致。有现成的对称性测试守着，加键必须两侧都加。
4. **commit 用中文，不带任何 AI 署名**（无 `Co-Authored-By`、无 `Claude-Session`、无 `🤖`）。`git add` 与 `git commit` 必须分两条命令执行，不能用 `&&` 串在一起——串行会撞 index.lock。
5. **不 push。** 除非计划里明说。
6. **失败判定看响应体不看状态码**：外部 provider 实测会用 HTTP 200 携带 `{"error":{...}}` 返回限流。任何解析 LLM 响应的地方都要先查 `error` 字段。
7. **绝不硬编码任何厂商专属字段**（`thinking`、`enable_thinking` 之类）。这类参数一律走 `PANEL_LLM_EXTRA_BODY` 透传。
8. **没有任何自动路径通向 LLM 请求**。进页面、切 tab、刷新 README 都不得发起。只有用户点「开始解析 / 重新解析」才发。

## 文件结构

**新建 — 纯逻辑（`src/lib/`，都带同名 `.test.ts`）**

| 文件 | 职责 |
|---|---|
| `readme-verify.ts` | 字面回证：值能否在原文里命中 + 命中句定位。**本批承重墙** |
| `readme-candidates.ts` | 候选片段切分：从 README 里挑出最可能含参数的段落，控制在预算内 |
| `llm-json.ts` | 从模型输出的一坨文本里宽松地抠出 JSON |
| `llm-profiles.ts` | 原始 JSON → `RecommendedProfile[]`，逐字段过回证，产出丢弃计数 |
| `recommend-tabs.ts` | 推荐卡的 tab 判定：哪些 tab 出现、默认选谁、计数怎么显示 |
| `llm-extra-body.ts` | `PANEL_LLM_EXTRA_BODY` 的解析与合并顺序 |

**新建 — 服务端（`src/server/llm/`）**

| 文件 | 职责 |
|---|---|
| `engine.ts` | `ExtractEngine` 接口 + 两个实现共用的请求体装配 |
| `external.ts` | 外部 OpenAI 兼容引擎（走出站代理） |
| `local.ts` | 本地引擎（直连运行中的 llama-server 容器） |
| `settings.ts` | 引擎选择与外部凭据的 env/db 双源读写 |
| `extract.ts` | 编排：候选片段 → 引擎流式 → 累积 → 解析 → 回证 → 落库 |

**新建 — 路由与组件**

```
src/app/api/v1/repos/[id]/readme/llm/route.ts        POST，SSE
src/app/api/v1/repos/[id]/readme/llm/save/route.ts   POST，落库
src/app/api/v1/settings/llm/route.ts                 GET|PUT
src/app/api/v1/settings/llm/test/route.ts            POST
src/components/settings/llm-card.tsx                 设置页第 9 张卡
src/components/models/recommend-tabs-card.tsx        推荐卡外壳（tab + 卡头 + 入口）
src/components/models/llm-extract-panel.tsx          AI 解析 tab 的四种状态
src/components/models/llm-diff-dialog.tsx            重跑覆盖对比弹层
```

**修改**

| 文件 | 改什么 |
|---|---|
| `src/server/migrations.ts` | 追加 v16：`repo_readme` 加五列 |
| `src/server/hf/readme.ts` | 读写新列；`ReadmeCacheRow` 加字段 |
| `src/lib/readme-params.ts` | `RecommendedProfile` 加可选 `hits` 字段 |
| `src/app/api/v1/repos/[id]/readme/route.ts` | 响应加 `llm` 段 |
| `src/components/models/recommend-profile-card.tsx` | 支持 `llm` 来源徽章 + 命中句展开 |
| `src/app/(panel)/models/repos/[id]/readme-view.tsx` | 推荐区换成 `RecommendTabsCard` |
| `src/app/(panel)/settings/page.tsx` | 挂第 9 张卡 |
| `src/i18n/messages/{zh,en}.json` | 新增文案，两侧对称 |
| `deploy/.env.example`、`deploy/docker-compose.yml` | 已在开工前完成，本计划不再动 |

---

### 任务 1：迁移 v16 与 LLM 缓存列的读写

这一批的所有数据都落在这五列上。先把存储打通，后面的任务才有地方放结果。

**文件：**
- 修改：`src/server/migrations.ts`（数组尾部追加一条）
- 修改：`src/server/hf/readme.ts`
- 测试：`src/server/hf/readme.test.ts`（追加一个 describe）

- [ ] **步骤 1：编写失败的测试**

在 `src/server/hf/readme.test.ts` 末尾追加：

```ts
describe("LLM 解析结果的独立列（批 3）", () => {
  it("新拉的 README 五个 llm 列都是 null", async () => {
    await getReadme(db, "o/r", { hf: {}, fetchImpl: stubFetch(() => ok("# Hello")) });
    expect(readLlmCache(db, "o/r")).toEqual({
      profiles: null,
      engine: null,
      model: null,
      contentSha: null,
      parsedAt: null,
    });
  });

  it("saveLlmCache 写入后读得回来", async () => {
    await getReadme(db, "o/r", { hf: {}, fetchImpl: stubFetch(() => ok("# Hello")) });
    saveLlmCache(db, "o/r", {
      profiles: '[{"id":"llm-1"}]',
      engine: "external",
      model: "GLM-4.7-Flash",
      contentSha: "abc",
    });

    const row = readLlmCache(db, "o/r");
    expect(row?.profiles).toBe('[{"id":"llm-1"}]');
    expect(row?.engine).toBe("external");
    expect(row?.model).toBe("GLM-4.7-Flash");
    expect(row?.contentSha).toBe("abc");
    expect(typeof row?.parsedAt).toBe("number");
  });

  // 这条是 D2 的核心保证：规则那一列重算，不许碰 AI 那一列
  it("README 刷新导致规则结果重算，llm 列原样保留", async () => {
    await getReadme(db, "o/r", { hf: {}, fetchImpl: stubFetch(() => ok("# v1")) });
    saveLlmCache(db, "o/r", {
      profiles: '[{"id":"llm-1"}]',
      engine: "external",
      model: "m",
      contentSha: "sha-of-v1",
    });

    await getReadme(db, "o/r", {
      hf: {},
      refresh: true,
      fetchImpl: stubFetch(() => ok("# v2 完全不同的内容")),
    });

    const row = readLlmCache(db, "o/r");
    expect(row?.profiles).toBe('[{"id":"llm-1"}]');
    expect(row?.engine).toBe("external");
  });

  it("README 变了之后 llm_content_sha 与当前 content_sha 不再相等（供 UI 标过期）", async () => {
    await getReadme(db, "o/r", { hf: {}, fetchImpl: stubFetch(() => ok("# v1")) });
    const shaV1 = readReadmeCache(db, "o/r")!.contentSha!;
    saveLlmCache(db, "o/r", { profiles: "[]", engine: "local", model: "m", contentSha: shaV1 });

    await getReadme(db, "o/r", {
      hf: {},
      refresh: true,
      fetchImpl: stubFetch(() => ok("# v2")),
    });

    expect(readLlmCache(db, "o/r")?.contentSha).toBe(shaV1);
    expect(readReadmeCache(db, "o/r")?.contentSha).not.toBe(shaV1);
  });

  it("README 行不存在时 saveLlmCache 不建行、不抛错", () => {
    expect(() => {
      saveLlmCache(db, "never/fetched", { profiles: "[]", engine: "local", model: "m", contentSha: "x" });
    }).not.toThrow();
    expect(readLlmCache(db, "never/fetched")).toBeNull();
  });
});
```

同时把文件顶部的 import 补上 `readLlmCache` 与 `saveLlmCache`：

```ts
import { MAX_README_BYTES, PROFILES_ENGINE, getReadme, readLlmCache, readReadmeCache, saveLlmCache } from "./readme";
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm vitest run src/server/hf/readme.test.ts`
预期：FAIL，`readLlmCache is not a function`

- [ ] **步骤 3：加迁移**

`src/server/migrations.ts`，在 `MIGRATIONS` 数组**末尾**追加一个元素（不要动任何既有元素）：

```ts
  // v16：README 的 LLM 解析结果（批 3）。五列全部可空，纯追加、旧代码忽略即可回滚，
  // 与 v13/v14/v15 同一条纪律：只 ALTER ADD COLUMN，不改既有列、不写数据迁移。
  //
  // 为什么与规则结果分列而不是合并进 profiles：规则抽取器 bump PROFILES_ENGINE
  // 会让整列重算，若共用一列，用户花 API 额度换来的 AI 结果会跟着一起没。
  // 反过来 AI 重解析也不该动规则那一列。
  //
  // llm_content_sha 存的是「解析当时 README 的 sha」，与当前 content_sha 不等
  // 只标过期、不删结果——花钱换来的东西不替用户丢。
  `
ALTER TABLE repo_readme ADD COLUMN llm_profiles TEXT;
ALTER TABLE repo_readme ADD COLUMN llm_engine TEXT;
ALTER TABLE repo_readme ADD COLUMN llm_model TEXT;
ALTER TABLE repo_readme ADD COLUMN llm_content_sha TEXT;
ALTER TABLE repo_readme ADD COLUMN llm_parsed_at INTEGER;
`,
```

- [ ] **步骤 4：加读写函数**

`src/server/hf/readme.ts`，在 `readReadmeCache` 下方追加：

```ts
/** LLM 解析结果的五列。与规则结果（profiles / profiles_engine / parsed_at）
 *  完全分开，互不影响——理由见 migrations.ts 的 v16 注释 */
export interface LlmCacheRow {
  /** RecommendedProfile[] 的 JSON 文本；null = 从没解析过 */
  profiles: string | null;
  engine: string | null;
  /** 实际用的模型 id，卡头要显示——用户需要知道这份结果是谁给的 */
  model: string | null;
  /** 解析当时 README 的 sha；与当前 contentSha 不等即为过期 */
  contentSha: string | null;
  parsedAt: number | null;
}

interface LlmRow {
  llm_profiles: string | null;
  llm_engine: string | null;
  llm_model: string | null;
  llm_content_sha: string | null;
  llm_parsed_at: number | null;
}

export function readLlmCache(db: Database.Database, repo: string): LlmCacheRow | null {
  const row = db
    .prepare(
      `SELECT llm_profiles, llm_engine, llm_model, llm_content_sha, llm_parsed_at
       FROM repo_readme WHERE repo = ?`,
    )
    .get(repo) as LlmRow | undefined;
  if (row === undefined) return null;
  return {
    profiles: row.llm_profiles,
    engine: row.llm_engine,
    model: row.llm_model,
    contentSha: row.llm_content_sha,
    parsedAt: row.llm_parsed_at,
  };
}

/**
 * 写入 LLM 解析结果。
 *
 * **只 UPDATE、不 INSERT**：LLM 解析必然发生在 README 已经拉到之后，没有那一行
 * 就说明调用方的时序错了。这里静默 no-op 而不是建一行半截记录——建出来的行
 * content 为 NULL，会被 getReadme 的早返回当成「问过了，这个仓库没有 README」，
 * 从此再也不去拉真正的 README。
 */
export function saveLlmCache(
  db: Database.Database,
  repo: string,
  row: { profiles: string; engine: string; model: string; contentSha: string },
): void {
  db.prepare(
    `UPDATE repo_readme
     SET llm_profiles = ?, llm_engine = ?, llm_model = ?, llm_content_sha = ?, llm_parsed_at = ?
     WHERE repo = ?`,
  ).run(row.profiles, row.engine, row.model, row.contentSha, Date.now(), repo);
}
```

- [ ] **步骤 5：运行测试验证通过**

运行：`pnpm vitest run src/server/hf/readme.test.ts`
预期：PASS，含新增 5 个用例

- [ ] **步骤 6：全量回归**

运行：`pnpm test`
预期：全绿。**迁移改动会影响所有建库的测试**，这一步不能跳。

- [ ] **步骤 7：Commit**

```bash
git add src/server/migrations.ts src/server/hf/readme.ts src/server/hf/readme.test.ts
```

```bash
git commit -m "feat(readme-llm): 迁移 v16 新增 LLM 结果五列与读写函数"
```

---

### 任务 2：字面回证（本批承重墙）

LLM 抽取的唯一可信性来源。**每个字段的值必须能在 README 原文里命中，否则丢弃。** 纯函数、无 IO。

**文件：**
- 创建：`src/lib/readme-verify.ts`
- 测试：`src/lib/readme-verify.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
import { describe, expect, it } from "vitest";

import { verifyValue } from "./readme-verify";

const R1 = "Set the temperature within the range of 0.5-0.7 (0.6 is recommended) to prevent endless repetitions.";

describe("verifyValue 数值通道", () => {
  it("原样出现即命中，并带回命中所在的整句", () => {
    const hit = verifyValue(0.6, R1);
    expect(hit).not.toBeNull();
    expect(hit!.sentence).toContain("0.6 is recommended");
  });

  it("小数尾零等值命中：README 写 0.60，AI 给 0.6", () => {
    expect(verifyValue(0.6, "use temp 0.60 for best results")).not.toBeNull();
  });

  it("千分位逗号等值命中：README 写 32,768，AI 给 32768", () => {
    expect(verifyValue(32768, "context length is 32,768 tokens")).not.toBeNull();
  });

  it("整数与浮点写法等值命中：README 写 1.0，AI 给 1", () => {
    expect(verifyValue(1, "repeat_penalty 1.0")).not.toBeNull();
  });

  // 这条是数值通道存在的全部理由：字符串 includes 会把 "0.6" 在 "10.65" 里认成命中
  it("不做子串匹配：0.6 不命中 10.65", () => {
    expect(verifyValue(0.6, "the value is 10.65 here")).toBeNull();
  });

  it("范围值不算命中：原文只写了 0.5-0.7 时 0.6 不命中", () => {
    expect(verifyValue(0.6, "temperature in the range 0.5-0.7")).toBeNull();
  });

  it("不做单位换算：32768 不命中 32k", () => {
    expect(verifyValue(32768, "context 32k tokens")).toBeNull();
  });

  it("负数命中", () => {
    expect(verifyValue(-1, "set dry_penalty_last_n to -1")).not.toBeNull();
  });
});

describe("verifyValue 字符串与布尔通道", () => {
  it("字符串归一化后原样命中", () => {
    expect(verifyValue("q8_0", "--cache-type-k q8_0 --cache-type-v q8_0")).not.toBeNull();
  });

  it("大小写不敏感", () => {
    expect(verifyValue("Q8_0", "use q8_0 for the kv cache")).not.toBeNull();
  });

  it("布尔按字面量命中", () => {
    expect(verifyValue(true, "set enable_thinking: true")).not.toBeNull();
    expect(verifyValue(false, "set enable_thinking: true")).toBeNull();
  });

  it("原文里没有就是没有", () => {
    expect(verifyValue("q4_0", "--cache-type-k q8_0")).toBeNull();
  });
});

describe("命中句定位", () => {
  it("按句末标点切句，不把整段带出来", () => {
    const body = "First sentence here. Set temperature to 0.6 now. Third sentence.";
    const hit = verifyValue(0.6, body);
    expect(hit!.sentence).toBe("Set temperature to 0.6 now.");
  });

  it("中文句号同样切句", () => {
    const body = "这是第一句。温度建议设为 0.6 效果最好。这是第三句。";
    expect(verifyValue(0.6, body)!.sentence).toBe("温度建议设为 0.6 效果最好。");
  });

  it("换行也是句边界", () => {
    const body = "line one\ntemperature 0.6\nline three";
    expect(verifyValue(0.6, body)!.sentence).toBe("temperature 0.6");
  });

  it("超长句硬截到 200 字符（与既有 excerpt 同口径）", () => {
    const body = `${"x".repeat(400)} 0.6 ${"y".repeat(400)}`;
    const hit = verifyValue(0.6, body);
    expect(hit!.sentence.length).toBeLessThanOrEqual(200);
    expect(hit!.sentence).toContain("0.6");
  });
});

describe("边界", () => {
  it("空原文一律不命中", () => {
    expect(verifyValue(0.6, "")).toBeNull();
  });

  it("null / undefined 值不命中，且不抛错", () => {
    expect(verifyValue(null, R1)).toBeNull();
    expect(verifyValue(undefined, R1)).toBeNull();
  });

  it("NaN 不命中", () => {
    expect(verifyValue(Number.NaN, "0.6")).toBeNull();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm vitest run src/lib/readme-verify.test.ts`
预期：FAIL，模块不存在

- [ ] **步骤 3：编写实现**

`src/lib/readme-verify.ts`：

```ts
/**
 * 字面回证：LLM 给出的值能否在 README 原文里找到（README 推荐参数的 LLM 解析，批 3）
 *
 * **这是 LLM 抽取唯一的可信性闸门。** 命中才留，不命中一律丢弃。它把「模型编造一个
 * 看起来很合理的 temp=0.7」这类幻觉压到接近 0——编出来的值不可能恰好出现在原文里。
 *
 * 双通道，**都不做单位换算**：
 * - 数值：把原文扫成数字 token 逐个做数值相等。刻意不用字符串 includes——
 *   `"0.6"` 是 `"10.65"` 的子串，用 includes 会把一个完全无关的数字认成命中，
 *   而这正是闸门最不能出的错
 * - 字符串 / 布尔：归一化（小写、去首尾空白）后原样 includes
 *
 * `32k → 32768` 这类换算属于「解释」而非「抽取」，且 32k 到底是 32000 还是 32768
 * 从文本本身判不出来，一律不做。
 */

/** 命中句硬上限，与 readme-params.ts 的 excerpt 同口径 */
const MAX_SENTENCE = 200;

/** 千分位逗号、可选小数、可选负号 */
const NUMBER_TOKEN = /-?\d+(?:,\d{3})*(?:\.\d+)?/g;

/** 句末标点（英文句点单独判：要求后面跟空白或结尾，免得把 v1.5 里的点当句号） */
const HARD_BREAK = "\n。！？!?";

function isBreak(body: string, i: number): boolean {
  const ch = body[i];
  if (ch === undefined) return false;
  if (HARD_BREAK.includes(ch)) return true;
  return ch === "." && /\s|^$/.test(body[i + 1] ?? "");
}

export interface VerifyHit {
  /** 命中所在的整句原文，≤200 字符 */
  sentence: string;
}

/** 从命中位置向两侧扩到句边界，再 trim 并截断 */
function sentenceAt(body: string, index: number, length: number): string {
  let start = 0;
  let end = body.length;

  for (let i = index - 1; i >= 0; i--) {
    if (isBreak(body, i)) {
      start = i + 1;
      break;
    }
  }
  for (let i = index + length; i < body.length; i++) {
    if (isBreak(body, i)) {
      // 换行本身不属于句子，标点属于
      end = body[i] === "\n" ? i : i + 1;
      break;
    }
  }

  const sentence = body.slice(start, end).trim();
  if (sentence.length <= MAX_SENTENCE) return sentence;

  // 超长时以命中点为中心截取，保证命中的那个值本身留在窗口里——
  // 截出一段不含被回证值的原文，对用户毫无核对价值
  const center = index - start;
  const half = Math.floor(MAX_SENTENCE / 2);
  const from = Math.max(0, Math.min(center - half, sentence.length - MAX_SENTENCE));
  return sentence.slice(from, from + MAX_SENTENCE).trim();
}

function verifyNumber(value: number, body: string): VerifyHit | null {
  if (!Number.isFinite(value)) return null;
  NUMBER_TOKEN.lastIndex = 0;
  for (let m = NUMBER_TOKEN.exec(body); m !== null; m = NUMBER_TOKEN.exec(body)) {
    if (Number(m[0].replace(/,/g, "")) === value) {
      return { sentence: sentenceAt(body, m.index, m[0].length) };
    }
  }
  return null;
}

function verifyText(value: string, body: string): VerifyHit | null {
  const needle = value.trim().toLowerCase();
  if (needle === "") return null;
  const index = body.toLowerCase().indexOf(needle);
  return index === -1 ? null : { sentence: sentenceAt(body, index, needle.length) };
}

/** 命中返回命中句，不命中返回 null。调用方据此决定留下还是丢弃这个字段。 */
export function verifyValue(value: unknown, body: string): VerifyHit | null {
  if (body === "") return null;
  if (typeof value === "number") return verifyNumber(value, body);
  if (typeof value === "boolean") return verifyText(String(value), body);
  if (typeof value === "string") return verifyText(value, body);
  return null;
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm vitest run src/lib/readme-verify.test.ts`
预期：PASS，19 个用例全绿

- [ ] **步骤 5：Commit**

```bash
git add src/lib/readme-verify.ts src/lib/readme-verify.test.ts
```

```bash
git commit -m "feat(readme-llm): 字面回证双通道与命中句定位"
```

---

### 任务 3：候选片段切分

不喂整篇 README：本地模型 `ctx_size` 配小了必然截断，长上下文也让模型更容易发散。按段落打分挑出最可能含参数的部分，控制在预算内。

**文件：**
- 创建：`src/lib/readme-candidates.ts`
- 测试：`src/lib/readme-candidates.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
import { describe, expect, it } from "vitest";

import { readmeCandidates } from "./readme-candidates";

describe("readmeCandidates", () => {
  it("含参数关键词的段落优先于不含的", () => {
    const body = [
      "This model is a fine-tune of something.",
      "Set the temperature to 0.6 and top_p to 0.95.",
    ].join("\n\n");

    const out = readmeCandidates(body, 60);
    expect(out.text).toContain("temperature");
    expect(out.text).not.toContain("fine-tune");
  });

  it("预算够时全部保留，并按原文顺序拼回", () => {
    const body = ["Set temperature 0.6.", "Intro paragraph.", "Use top_p 0.95."].join("\n\n");
    const out = readmeCandidates(body, 10_000);

    expect(out.truncated).toBe(false);
    expect(out.text.indexOf("temperature")).toBeLessThan(out.text.indexOf("top_p"));
    expect(out.text.indexOf("Intro")).toBeGreaterThan(out.text.indexOf("temperature"));
  });

  it("超预算时截断并标记", () => {
    const body = Array.from({ length: 50 }, (_, i) => `Paragraph ${i} with temperature 0.${i}.`).join("\n\n");
    const out = readmeCandidates(body, 200);

    expect(out.truncated).toBe(true);
    expect(out.text.length).toBeLessThanOrEqual(200);
  });

  it("中文关键词同样计分", () => {
    const body = ["这是一段介绍文字。", "推荐参数：温度 0.6，top_p 0.95。"].join("\n\n");
    const out = readmeCandidates(body, 60);
    expect(out.text).toContain("推荐参数");
  });

  it("代码块整块参与，不被段落切分打散", () => {
    const body = ["Intro.", "```bash\nllama-server --temp 0.6 \\\n  --top-p 0.95\n```"].join("\n\n");
    const out = readmeCandidates(body, 200);
    expect(out.text).toContain("--temp 0.6");
    expect(out.text).toContain("--top-p 0.95");
  });

  it("空输入产出空结果，不抛错", () => {
    expect(readmeCandidates("", 100)).toEqual({ text: "", truncated: false });
  });

  it("全是无关内容时也回一段（让模型自己判断没有，而不是面板替它判断）", () => {
    const out = readmeCandidates("Just a plain description of the model.", 500);
    expect(out.text).not.toBe("");
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm vitest run src/lib/readme-candidates.test.ts`
预期：FAIL，模块不存在

- [ ] **步骤 3：编写实现**

`src/lib/readme-candidates.ts`：

```ts
/**
 * README → 喂给 LLM 的候选片段（README 推荐参数的 LLM 解析，批 3）
 *
 * 不喂整篇有两个硬理由：本地引擎跑在用户自己配的 `ctx_size` 上，配小了必然
 * 静默截断；而长上下文里的无关内容会让模型去"推断"参数，那正是回证要挡的东西。
 *
 * 打分只看关键词密度，不做语义判断——判断留给模型，面板只负责别把明显无关的
 * 段落塞进去。全篇都无关时仍然回一段：让模型自己说"没有"，比面板替它判断更诚实。
 */

/** 默认预算，约 1.5k token（中文更省，英文约 1.5 字符/token 的保守估计） */
export const DEFAULT_CANDIDATE_BUDGET = 6000;

const KEYWORDS = [
  "temperature", "temp", "top_p", "top-p", "top_k", "top-k", "min_p", "min-p",
  "penalty", "ctx", "context", "n_gpu_layers", "ngl", "flash", "cache-type",
  "recommend", "setting", "parameter", "sampling", "llama-server", "llama-cli",
  "推荐", "参数", "温度", "采样", "配置",
];

interface Block {
  /** 在原文中的序号，用于最后按原文序拼回 */
  order: number;
  text: string;
  score: number;
}

/** 先按 fenced code block 切开，块内不再按空行拆——一条多行命令必须整块保留 */
function splitBlocks(body: string): string[] {
  const out: string[] = [];
  const fence = /```[\s\S]*?```/g;
  let last = 0;
  for (let m = fence.exec(body); m !== null; m = fence.exec(body)) {
    out.push(...body.slice(last, m.index).split(/\n{2,}/));
    out.push(m[0]);
    last = m.index + m[0].length;
  }
  out.push(...body.slice(last).split(/\n{2,}/));
  return out.map((s) => s.trim()).filter((s) => s !== "");
}

function scoreOf(text: string): number {
  const lower = text.toLowerCase();
  return KEYWORDS.reduce((sum, kw) => (lower.includes(kw) ? sum + 1 : sum), 0);
}

export interface CandidateText {
  text: string;
  /** true = 有段落因预算被丢掉，UI 需要如实告知 */
  truncated: boolean;
}

export function readmeCandidates(
  body: string,
  budget: number = DEFAULT_CANDIDATE_BUDGET,
): CandidateText {
  const blocks: Block[] = splitBlocks(body).map((text, order) => ({
    order,
    text,
    score: scoreOf(text),
  }));
  if (blocks.length === 0) return { text: "", truncated: false };

  // 高分在前；同分保持原文序，让拼回的结果尽量贴近原文结构
  const ranked = [...blocks].sort((a, b) => (b.score - a.score) || (a.order - b.order));

  const picked: Block[] = [];
  let used = 0;
  let truncated = false;
  for (const block of ranked) {
    const cost = block.text.length + 2; // 段落间的空行
    if (used + cost > budget) {
      truncated = true;
      continue; // 继续试后面更短的段落，而不是直接停——短段落也可能含关键信息
    }
    picked.push(block);
    used += cost;
  }

  // 一段都放不下时，截取分最高的那段的前 budget 个字符：空片段等于放弃整个功能
  if (picked.length === 0) {
    return { text: ranked[0]!.text.slice(0, budget), truncated: true };
  }

  picked.sort((a, b) => a.order - b.order);
  return { text: picked.map((b) => b.text).join("\n\n"), truncated };
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm vitest run src/lib/readme-candidates.test.ts`
预期：PASS，7 个用例全绿

- [ ] **步骤 5：Commit**

```bash
git add src/lib/readme-candidates.ts src/lib/readme-candidates.test.ts
```

```bash
git commit -m "feat(readme-llm): 候选片段按关键词打分切分与预算控制"
```

---

### 任务 4：从模型输出里宽松地抠 JSON

模型即使被要求只输出 JSON，也可能包在 ```` ```json ```` 围栏里、前后加一句话，或者被 `max_tokens` 截断。这一层负责把能用的抠出来，抠不出就诚实地返回 null。

**文件：**
- 创建：`src/lib/llm-json.ts`
- 测试：`src/lib/llm-json.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
import { describe, expect, it } from "vitest";

import { extractJson } from "./llm-json";

describe("extractJson", () => {
  it("纯 JSON 直接解析", () => {
    expect(extractJson('{"temp":0.6}')).toEqual({ temp: 0.6 });
  });

  it("剥掉 ```json 围栏", () => {
    expect(extractJson('```json\n{"temp":0.6}\n```')).toEqual({ temp: 0.6 });
  });

  it("剥掉无语言标记的围栏", () => {
    expect(extractJson('```\n{"temp":0.6}\n```')).toEqual({ temp: 0.6 });
  });

  it("忽略 JSON 前后的废话", () => {
    expect(extractJson('好的，结果如下：\n{"temp":0.6}\n希望有帮助！')).toEqual({ temp: 0.6 });
  });

  it("正确平衡嵌套花括号", () => {
    expect(extractJson('前言 {"a":{"b":{"c":1}}} 后记')).toEqual({ a: { b: { c: 1 } } });
  });

  it("字符串字面量里的花括号不参与配平", () => {
    expect(extractJson('{"note":"用 {} 包起来","temp":0.6}')).toEqual({
      note: "用 {} 包起来",
      temp: 0.6,
    });
  });

  it("转义引号不打断字符串状态", () => {
    expect(extractJson('{"note":"他说\\"好\\"","temp":0.6}')).toEqual({
      note: '他说"好"',
      temp: 0.6,
    });
  });

  it("被截断的 JSON 返回 null，不做补全", () => {
    expect(extractJson('{"profiles":[{"temp":0.6')).toBeNull();
  });

  it("完全不是 JSON 返回 null", () => {
    expect(extractJson("在英文句子中，要抠出 temperature: 0.6，通常可以理解为…")).toBeNull();
  });

  it("空串返回 null", () => {
    expect(extractJson("")).toBeNull();
  });

  it("只有数组不接受——契约要求顶层是对象", () => {
    expect(extractJson("[1,2,3]")).toBeNull();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm vitest run src/lib/llm-json.test.ts`
预期：FAIL，模块不存在

- [ ] **步骤 3：编写实现**

`src/lib/llm-json.ts`：

```ts
/**
 * 从模型输出的一坨文本里抠出 JSON（README 推荐参数的 LLM 解析，批 3）
 *
 * 即使请求里带了 `response_format: json_object`，也不能假定拿到的就是纯 JSON：
 * 实测某些 provider 对 `json_schema` **静默失效**——HTTP 200、不报错，返回的却是
 * 散文。约束是尽力而为，这一层才是真正的防线。
 *
 * **抠不出就返回 null，绝不补全**。给一个被 max_tokens 截断的 JSON 补上收尾括号，
 * 等于替模型编造它没说完的话，而下游的回证根本挡不住这种编造——那些值确实
 * 在原文里出现过，只是模型还没说完它要把它们放在哪。
 */

/** 顶层必须是对象：数组无法承载 profiles 之外的元信息，也不是 prompt 约定的形状 */
export function extractJson(raw: string): Record<string, unknown> | null {
  const text = stripFence(raw).trim();
  if (text === "") return null;

  const start = text.indexOf("{");
  if (start === -1) return null;

  const end = matchingBrace(text, start);
  if (end === -1) return null;

  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function stripFence(raw: string): string {
  const fence = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/.exec(raw);
  return fence === null ? raw : fence[1]!;
}

/** 从 start 处的 `{` 找配对的 `}`；字符串字面量内的括号不计数。找不到返回 -1 */
function matchingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm vitest run src/lib/llm-json.test.ts`
预期：PASS，11 个用例全绿

- [ ] **步骤 5：Commit**

```bash
git add src/lib/llm-json.ts src/lib/llm-json.test.ts
```

```bash
git commit -m "feat(readme-llm): 模型输出的宽松 JSON 提取"
```

---

### 任务 5：原始 JSON → 经回证的 profiles

把模型吐的东西变成推荐卡能渲染的 `RecommendedProfile[]`，逐字段过回证闸门，并如实统计丢了多少。

**模型输出的契约**（写在 prompt 里，任务 7 会用到）：

```json
{ "profiles": [ { "label": "Recommended settings", "params": { "temp": 0.6, "top_p": 0.95 } } ] }
```

**文件：**
- 创建：`src/lib/llm-profiles.ts`
- 测试：`src/lib/llm-profiles.test.ts`
- 修改：`src/lib/readme-params.ts`（`RecommendedProfile` 加 `hits`；导出 `profileId`）

- [ ] **步骤 1：编写失败的测试**

```ts
import { describe, expect, it } from "vitest";

import { buildLlmProfiles } from "./llm-profiles";

const BODY = "Set the temperature within the range of 0.5-0.7 (0.6 is recommended). Use top_p 0.95.";

describe("buildLlmProfiles", () => {
  it("回证通过的字段进 server，并记下命中句", () => {
    const out = buildLlmProfiles(
      { profiles: [{ label: "Recommended", params: { temp: 0.6, top_p: 0.95 } }] },
      BODY,
    );

    expect(out.profiles).toHaveLength(1);
    expect(out.profiles[0]!.server).toEqual({ temp: 0.6, top_p: 0.95 });
    expect(out.profiles[0]!.source).toBe("llm");
    expect(out.profiles[0]!.label).toBe("Recommended");
    expect(out.profiles[0]!.hits!.temp).toContain("0.6 is recommended");
  });

  // 幻觉的典型形态：值合法、字段合法，就是原文里没写过
  it("回证不过的字段被丢弃并计数", () => {
    const out = buildLlmProfiles(
      { profiles: [{ label: "X", params: { temp: 0.6, top_k: 40 } }] },
      BODY,
    );

    expect(out.profiles[0]!.server).toEqual({ temp: 0.6 });
    expect(out.offered).toBe(2);
    expect(out.dropped).toBe(1);
  });

  it("超出字段 schema 值域的一律丢弃，不钳", () => {
    const out = buildLlmProfiles({ profiles: [{ label: "X", params: { temp: 5 } }] }, "temp 5");
    expect(out.profiles).toHaveLength(0);
    expect(out.dropped).toBe(1);
  });

  it("认不出的字段进 extras，不算 dropped", () => {
    const out = buildLlmProfiles(
      { profiles: [{ label: "X", params: { temp: 0.6, "spec-type": "draft-mtp" } }] },
      BODY,
    );

    expect(out.profiles[0]!.extras).toEqual([{ flag: "spec-type", value: "draft-mtp" }]);
    expect(out.dropped).toBe(0);
  });

  it("一个字段都没剩的 profile 整条丢掉", () => {
    const out = buildLlmProfiles({ profiles: [{ label: "X", params: { top_k: 40 } }] }, BODY);
    expect(out.profiles).toHaveLength(0);
  });

  it("同义词归一化：repetition_penalty → repeat_penalty", () => {
    const out = buildLlmProfiles(
      { profiles: [{ label: "X", params: { repetition_penalty: 1.1 } }] },
      "repetition_penalty 1.1 works well",
    );
    expect(out.profiles[0]!.server).toEqual({ repeat_penalty: 1.1 });
  });

  it("label 缺失时给空串，由 UI 决定显示什么", () => {
    const out = buildLlmProfiles({ profiles: [{ params: { temp: 0.6 } }] }, BODY);
    expect(out.profiles[0]!.label).toBe("");
  });

  it("多套推荐各自成卡", () => {
    const body = "Thinking: temp 0.6. Non-thinking: temp 0.7.";
    const out = buildLlmProfiles(
      {
        profiles: [
          { label: "Thinking", params: { temp: 0.6 } },
          { label: "Non-thinking", params: { temp: 0.7 } },
        ],
      },
      body,
    );
    expect(out.profiles).toHaveLength(2);
    expect(out.profiles.map((p) => p.id)).toHaveLength(new Set(out.profiles.map((p) => p.id)).size);
  });

  it("字段签名相同的两套只留一套", () => {
    const out = buildLlmProfiles(
      {
        profiles: [
          { label: "A", params: { temp: 0.6 } },
          { label: "B", params: { temp: 0.6 } },
        ],
      },
      BODY,
    );
    expect(out.profiles).toHaveLength(1);
  });

  it("形状不对的输入一律产出空结果，不抛错", () => {
    expect(buildLlmProfiles({}, BODY).profiles).toEqual([]);
    expect(buildLlmProfiles({ profiles: "nope" }, BODY).profiles).toEqual([]);
    expect(buildLlmProfiles({ profiles: [null, 42] }, BODY).profiles).toEqual([]);
    expect(buildLlmProfiles({ profiles: [{ params: null }] }, BODY).profiles).toEqual([]);
  });

  it("confidence 恒为 medium —— AI 结果不该与规则结果同级", () => {
    const out = buildLlmProfiles({ profiles: [{ label: "X", params: { temp: 0.6 } }] }, BODY);
    expect(out.profiles[0]!.confidence).toBe("medium");
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm vitest run src/lib/llm-profiles.test.ts`
预期：FAIL，模块不存在

- [ ] **步骤 3：扩展 `readme-params.ts`**

两处小改。给 `RecommendedProfile` 加可选字段（现有产出不填，类型兼容）：

```ts
export interface RecommendedProfile {
  id: string;
  label: string;
  source: "cli-block" | "kv-list" | "llm";
  server: Partial<ServerConfig>;
  extras: { flag: string; value: string }[];
  excerpt: string;
  confidence: "high" | "medium";
  /** 字段 → 该值在 README 里的命中句。**仅 `llm` 来源填**：规则抽取的位置
   *  信息已经由 excerpt 承载，而 AI 结果需要逐字段可核对（批 3） */
  hits?: Record<string, string>;
}
```

把 id 的拼法提成导出函数，供 `llm-profiles.ts` 复用——两处各拼一份就意味着
跨来源去重时签名对不上：

```ts
/** 稳定 id：来源前缀 + 字段签名短 hash。同样的字段集合必得同样的后缀，
 *  这是跨来源去重（规则 vs AI）能对上号的前提 */
export function profileId(source: RecommendedProfile["source"], server: Partial<ServerConfig>): string {
  return `${source}-${shortHash(signatureOf(server))}`;
}

/** 字段签名的短 hash，跨来源去重用它做桶 key（不含来源前缀） */
export function signatureHash(server: Partial<ServerConfig>): string {
  return shortHash(signatureOf(server));
}
```

`buildProfile` 内部改用 `profileId(source, typed)`，`extractRecommendations` 的
去重改用 `signatureHash(profile.server)`，行为不变。

- [ ] **步骤 4：编写 `llm-profiles.ts`**

```ts
import { serverConfigSchema, type ServerConfig } from "@/core/schemas";
import {
  profileId,
  signatureHash,
  toServerField,
  type RecommendedProfile,
} from "./readme-params";
import { verifyValue } from "./readme-verify";

/**
 * 模型输出的 JSON → 经回证的推荐卡数据（README 推荐参数的 LLM 解析，批 3）
 *
 * 每个字段要连过三道：
 * 1. **字段名认得出**（`toServerField`，与规则抽取器共用同一张同义词表）——认不出
 *    进 extras 如实展示，不算丢弃
 * 2. **值过得了该字段自己的 schema**——越界一律丢弃不钳，`temp: 5` 是模型错了，
 *    夹到 2 是替它圆谎
 * 3. **值能在 README 原文里字面命中**（`verifyValue`）——这一道挡的是幻觉
 *
 * `offered` / `dropped` 必须如实回给 UI。用户看到"给了 4 个、丢了 2 个"才知道
 * 这份结果经过了筛选，而不是模型只说了两句话。**这个计数不是调试信息。**
 */

export interface LlmExtractResult {
  profiles: RecommendedProfile[];
  /** 模型给出的字段总数（不含认不出的 extras） */
  offered: number;
  /** 因值域或回证不通过而丢弃的字段数 */
  dropped: number;
}

interface RawProfile {
  label?: unknown;
  params?: unknown;
}

const EMPTY: LlmExtractResult = { profiles: [], offered: 0, dropped: 0 };

export function buildLlmProfiles(raw: unknown, body: string): LlmExtractResult {
  if (raw === null || typeof raw !== "object") return EMPTY;
  const list = (raw as { profiles?: unknown }).profiles;
  if (!Array.isArray(list)) return EMPTY;

  const bySignature = new Map<string, RecommendedProfile>();
  let offered = 0;
  let dropped = 0;

  for (const item of list) {
    if (item === null || typeof item !== "object") continue;
    const { label, params } = item as RawProfile;
    if (params === null || typeof params !== "object" || Array.isArray(params)) continue;

    const server: Record<string, unknown> = {};
    const extras: { flag: string; value: string }[] = [];
    const hits: Record<string, string> = {};

    for (const [rawKey, rawValue] of Object.entries(params as Record<string, unknown>)) {
      const field = toServerField(rawKey);
      if (field === null) {
        extras.push({ flag: rawKey, value: String(rawValue) });
        continue;
      }

      offered++;
      const parsed = serverConfigSchema.shape[field].safeParse(rawValue);
      if (!parsed.success) {
        dropped++;
        continue;
      }
      const hit = verifyValue(parsed.data, body);
      if (hit === null) {
        dropped++;
        continue;
      }
      server[field] = parsed.data;
      hits[field] = hit.sentence;
    }

    if (Object.keys(server).length === 0) continue;

    const typed = server as Partial<ServerConfig>;
    const key = signatureHash(typed);
    if (bySignature.has(key)) continue; // 同一套值重复给出，留先到的

    bySignature.set(key, {
      id: profileId("llm", typed),
      label: typeof label === "string" ? label : "",
      source: "llm",
      server: typed,
      extras,
      // AI 结果的出处是逐字段的 hits，不需要整段 excerpt
      excerpt: "",
      // 恒为 medium：过了回证只说明"原文里有这个数"，不说明"作者是把它当这个参数推荐的"
      confidence: "medium",
      hits,
    });
  }

  return { profiles: [...bySignature.values()], offered, dropped };
}
```

- [ ] **步骤 5：运行测试验证通过**

运行：`pnpm vitest run src/lib/llm-profiles.test.ts src/lib/readme-params.test.ts`
预期：两个文件都 PASS。`readme-params.test.ts` 必须一起跑——步骤 3 动了它的内部拼法。

- [ ] **步骤 6：Commit**

```bash
git add src/lib/llm-profiles.ts src/lib/llm-profiles.test.ts src/lib/readme-params.ts
```

```bash
git commit -m "feat(readme-llm): 模型输出装配为经回证的推荐卡数据"
```

---

### 任务 6：引擎配置的 env/db 双源读写

外部凭据照 `HF_TOKEN` 现成的双源模式：env 有值就优先且只读，没有才用设置页存进 db 的那份。**不新开凭据表**——`settings` 表已有 `outbound_proxy` 存带密码的代理 URL 的先例。

**文件：**
- 创建：`src/lib/llm-extra-body.ts` + `src/lib/llm-extra-body.test.ts`
- 创建：`src/server/llm/settings.ts` + `src/server/llm/settings.test.ts`

- [ ] **步骤 1：编写 `llm-extra-body` 的失败测试**

```ts
import { describe, expect, it } from "vitest";

import { mergeRequestBody, parseExtraBody } from "./llm-extra-body";

describe("parseExtraBody", () => {
  it("解析合法 JSON 对象", () => {
    expect(parseExtraBody('{"thinking":{"type":"disabled"}}')).toEqual({
      thinking: { type: "disabled" },
    });
  });

  it("未配置返回 null", () => {
    expect(parseExtraBody(null)).toBeNull();
    expect(parseExtraBody(undefined)).toBeNull();
    expect(parseExtraBody("  ")).toBeNull();
  });

  // 非法配置不该让整个解析功能崩掉——用户填错一个字符不等于功能不可用
  it("非法 JSON 返回 null，不抛错", () => {
    expect(parseExtraBody("{不是 JSON")).toBeNull();
  });

  it("顶层不是对象一律拒绝", () => {
    expect(parseExtraBody("[1,2]")).toBeNull();
    expect(parseExtraBody('"str"')).toBeNull();
    expect(parseExtraBody("42")).toBeNull();
  });
});

describe("mergeRequestBody", () => {
  it("额外字段合并进请求体", () => {
    const out = mergeRequestBody({ thinking: { type: "disabled" } }, { model: "m", stream: true });
    expect(out).toEqual({ thinking: { type: "disabled" }, model: "m", stream: true });
  });

  // 不允许用户从这个口子改掉面板的核心请求语义
  it("面板自己的字段永远覆盖额外字段", () => {
    const out = mergeRequestBody({ model: "用户想换的", stream: false }, { model: "面板定的", stream: true });
    expect(out.model).toBe("面板定的");
    expect(out.stream).toBe(true);
  });

  it("额外字段为 null 时原样返回核心字段", () => {
    expect(mergeRequestBody(null, { model: "m" })).toEqual({ model: "m" });
  });
});
```

- [ ] **步骤 2：运行验证失败**

运行：`pnpm vitest run src/lib/llm-extra-body.test.ts`
预期：FAIL，模块不存在

- [ ] **步骤 3：写 `src/lib/llm-extra-body.ts`**

```ts
/**
 * `PANEL_LLM_EXTRA_BODY`：透传给 provider 的额外请求体字段（批 3）
 *
 * **存在的理由是实测数据**：同一个抽取请求，推理模型开思考 1034 tokens、
 * 关思考 12 tokens，差 86 倍。但关思考的字段（智谱是 `thinking`）不是 OpenAI
 * 标准，把它硬编码进代码就等于把面板绑死在一个厂商上。
 *
 * 于是给用户一个通用口子，自己按 provider 文档填。代价是这段 JSON 不可校验语义——
 * 所以**非法内容一律降级为"没配"而不是报错**：填错一个字符不该让整个功能不可用。
 */

export function parseExtraBody(raw: string | null | undefined): Record<string, unknown> | null {
  if (raw === null || raw === undefined || raw.trim() === "") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * 合并顺序：额外字段在前、面板字段在后覆盖。
 * `model` / `messages` / `stream` / `response_format` 是面板的核心请求语义，
 * 用户从这个口子改掉它们只会让功能以难以诊断的方式失效。
 */
export function mergeRequestBody(
  extra: Record<string, unknown> | null,
  core: Record<string, unknown>,
): Record<string, unknown> {
  return extra === null ? core : { ...extra, ...core };
}
```

- [ ] **步骤 4：编写 `server/llm/settings` 的失败测试**

`src/server/llm/settings.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";

import { openDb, runMigrations } from "../db";
import { getLlmSettings, resolveLlmConfig, saveLlmSettings } from "./settings";

let db: Database.Database;
const ENV_KEYS = [
  "PANEL_LLM_BASE_URL",
  "PANEL_LLM_API_KEY",
  "PANEL_LLM_MODEL",
  "PANEL_LLM_EXTRA_BODY",
] as const;

beforeEach(() => {
  db = openDb(":memory:");
  runMigrations(db);
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("getLlmSettings", () => {
  it("全新库：引擎为 none，外部三项都没配", () => {
    const s = getLlmSettings(db);
    expect(s.engine).toBe("none");
    expect(s.externalReady).toBe(false);
    expect(s.missing).toEqual(["baseUrl", "apiKey", "model"]);
  });

  it("env 配齐三项即 ready，且来源标 env", () => {
    process.env.PANEL_LLM_BASE_URL = "https://api.example.com/v1";
    process.env.PANEL_LLM_API_KEY = "sk-0123456789abcdef";
    process.env.PANEL_LLM_MODEL = "gpt-4o-mini";

    const s = getLlmSettings(db);
    expect(s.externalReady).toBe(true);
    expect(s.missing).toEqual([]);
    expect(s.baseUrlSource).toBe("env");
    expect(s.keySource).toBe("env");
  });

  // 缺项要逐项点名，用户回设置页才知道补哪个
  it("只配了两项时，missing 精确指出缺的那一项", () => {
    process.env.PANEL_LLM_BASE_URL = "https://api.example.com/v1";
    process.env.PANEL_LLM_MODEL = "gpt-4o-mini";

    expect(getLlmSettings(db).missing).toEqual(["apiKey"]);
  });

  it("API Key 永不回明文，只回尾 4 位", () => {
    process.env.PANEL_LLM_API_KEY = "sk-0123456789abcdef";
    const s = getLlmSettings(db);

    expect(s.keyTail).toBe("cdef");
    expect(s.keySet).toBe(true);
    expect(JSON.stringify(s)).not.toContain("sk-0123456789abcdef");
  });

  it("env 优先于 db，且 env 来源在 UI 上应表现为只读", () => {
    saveLlmSettings(db, { baseUrl: "https://db.example.com/v1" });
    process.env.PANEL_LLM_BASE_URL = "https://env.example.com/v1";

    const s = getLlmSettings(db);
    expect(s.baseUrl).toBe("https://env.example.com/v1");
    expect(s.baseUrlSource).toBe("env");
  });

  it("env 缺席时落回 db", () => {
    saveLlmSettings(db, { baseUrl: "https://db.example.com/v1", model: "m", apiKey: "k-abcd1234" });

    const s = getLlmSettings(db);
    expect(s.baseUrl).toBe("https://db.example.com/v1");
    expect(s.baseUrlSource).toBe("db");
    expect(s.externalReady).toBe(true);
  });
});

describe("saveLlmSettings", () => {
  it("engine 只存 db，没有 env 覆盖", () => {
    saveLlmSettings(db, { engine: "external" });
    expect(getLlmSettings(db).engine).toBe("external");
  });

  it("apiKey 传 null 清除 db 里的那份", () => {
    saveLlmSettings(db, { apiKey: "k-abcd1234" });
    expect(getLlmSettings(db).keySet).toBe(true);

    saveLlmSettings(db, { apiKey: null });
    expect(getLlmSettings(db).keySet).toBe(false);
  });

  it("只传一项时不影响其他项", () => {
    saveLlmSettings(db, { baseUrl: "https://a.example.com/v1", model: "m" });
    saveLlmSettings(db, { model: "m2" });

    const s = getLlmSettings(db);
    expect(s.baseUrl).toBe("https://a.example.com/v1");
    expect(s.model).toBe("m2");
  });
});

describe("resolveLlmConfig", () => {
  it("回明文供服务端发请求用（这是唯一能拿到明文的入口）", () => {
    process.env.PANEL_LLM_API_KEY = "sk-secret-value";
    process.env.PANEL_LLM_BASE_URL = "https://api.example.com/v1/";
    process.env.PANEL_LLM_MODEL = "m";

    const c = resolveLlmConfig(db);
    expect(c.apiKey).toBe("sk-secret-value");
    // 末尾斜杠归一化掉：下游一律用 `${baseUrl}/chat/completions` 拼
    expect(c.baseUrl).toBe("https://api.example.com/v1");
  });

  it("extraBody 非法时降级为 null，不影响其余配置", () => {
    process.env.PANEL_LLM_EXTRA_BODY = "{不是 JSON";
    process.env.PANEL_LLM_MODEL = "m";

    const c = resolveLlmConfig(db);
    expect(c.extraBody).toBeNull();
    expect(c.model).toBe("m");
  });
});
```

- [ ] **步骤 5：运行验证失败**

运行：`pnpm vitest run src/server/llm/settings.test.ts`
预期：FAIL，模块不存在

- [ ] **步骤 6：写 `src/server/llm/settings.ts`**

```ts
import type Database from "better-sqlite3";

import { parseExtraBody } from "@/lib/llm-extra-body";

/**
 * LLM 解析引擎的配置读写（批 3）
 *
 * 外部凭据照 `hf/settings.ts` 的 `effectiveToken` 同构：**env 优先且只读，db 次之**。
 * 不新开凭据表——`settings` 表已经在存 `outbound_proxy`（同样含凭据），
 * `hf_token` 那张独立表是 M2 的历史形态，不作为新增时的样板。
 *
 * `engine` 只存 db：它是用户的一次选择，不是部署参数，没有 env 覆盖的必要。
 * 默认 `none`——装了面板不等于同意往外发请求。
 */

export type LlmEngine = "none" | "local" | "external";

const KEY = {
  engine: "llm_engine",
  baseUrl: "llm_base_url",
  apiKey: "llm_api_key",
  model: "llm_model",
  extraBody: "llm_extra_body",
} as const;

const ENV = {
  baseUrl: "PANEL_LLM_BASE_URL",
  apiKey: "PANEL_LLM_API_KEY",
  model: "PANEL_LLM_MODEL",
  extraBody: "PANEL_LLM_EXTRA_BODY",
} as const;

export type FieldSource = "env" | "db" | null;

export interface LlmSettingsSnapshot {
  engine: LlmEngine;
  baseUrl: string | null;
  baseUrlSource: FieldSource;
  keySet: boolean;
  /** 明文后 4 位，未设置为 null。**任何情况下都不回明文** */
  keyTail: string | null;
  keySource: FieldSource;
  model: string | null;
  modelSource: FieldSource;
  extraBody: string | null;
  extraBodySource: FieldSource;
  /** 外部三项是否配齐 */
  externalReady: boolean;
  /** 没配齐时缺哪些——UI 要逐项点名，只说"配置不完整"用户还得自己找 */
  missing: ("baseUrl" | "apiKey" | "model")[];
}

function readDb(db: Database.Database, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  const value = row?.value.trim();
  return value === undefined || value === "" ? undefined : value;
}

function effective(
  db: Database.Database,
  envKey: string,
  dbKey: string,
): { value: string | undefined; source: FieldSource } {
  const fromEnv = process.env[envKey]?.trim();
  if (fromEnv !== undefined && fromEnv !== "") return { value: fromEnv, source: "env" };
  const fromDb = readDb(db, dbKey);
  return fromDb === undefined ? { value: undefined, source: null } : { value: fromDb, source: "db" };
}

export function getLlmSettings(db: Database.Database): LlmSettingsSnapshot {
  const baseUrl = effective(db, ENV.baseUrl, KEY.baseUrl);
  const apiKey = effective(db, ENV.apiKey, KEY.apiKey);
  const model = effective(db, ENV.model, KEY.model);
  const extraBody = effective(db, ENV.extraBody, KEY.extraBody);

  const missing: ("baseUrl" | "apiKey" | "model")[] = [];
  if (baseUrl.value === undefined) missing.push("baseUrl");
  if (apiKey.value === undefined) missing.push("apiKey");
  if (model.value === undefined) missing.push("model");

  const rawEngine = readDb(db, KEY.engine);
  const engine: LlmEngine =
    rawEngine === "local" || rawEngine === "external" ? rawEngine : "none";

  return {
    engine,
    baseUrl: baseUrl.value ?? null,
    baseUrlSource: baseUrl.source,
    keySet: apiKey.value !== undefined,
    keyTail: apiKey.value === undefined ? null : apiKey.value.slice(-4),
    keySource: apiKey.source,
    model: model.value ?? null,
    modelSource: model.source,
    extraBody: extraBody.value ?? null,
    extraBodySource: extraBody.source,
    externalReady: missing.length === 0,
    missing,
  };
}

export interface LlmConfig {
  engine: LlmEngine;
  baseUrl: string | null;
  /** 明文。只在服务端发请求时使用，绝不进任何响应体 */
  apiKey: string | null;
  model: string | null;
  extraBody: Record<string, unknown> | null;
}

/** 服务端发请求用的生效配置（含明文 key）。这是唯一能拿到明文的入口 */
export function resolveLlmConfig(db: Database.Database): LlmConfig {
  const snapshot = getLlmSettings(db);
  const apiKey = effective(db, ENV.apiKey, KEY.apiKey).value ?? null;
  return {
    engine: snapshot.engine,
    // 末尾斜杠归一化：下游一律 `${baseUrl}/chat/completions`，留着斜杠会拼出 //
    baseUrl: snapshot.baseUrl === null ? null : snapshot.baseUrl.replace(/\/+$/, ""),
    apiKey,
    model: snapshot.model,
    extraBody: parseExtraBody(snapshot.extraBody),
  };
}

export interface LlmSettingsPatch {
  engine?: LlmEngine;
  /** null = 清除 db 里那份（env 若有仍然生效——那是部署方的决定，面板改不动） */
  baseUrl?: string | null;
  apiKey?: string | null;
  model?: string | null;
  extraBody?: string | null;
}

export function saveLlmSettings(db: Database.Database, patch: LlmSettingsPatch): void {
  const write = (key: string, value: string | null | undefined): void => {
    if (value === undefined) return;
    if (value === null || value.trim() === "") {
      db.prepare("DELETE FROM settings WHERE key = ?").run(key);
      return;
    }
    db.prepare(
      "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(key, value.trim());
  };

  write(KEY.engine, patch.engine);
  write(KEY.baseUrl, patch.baseUrl);
  write(KEY.apiKey, patch.apiKey);
  write(KEY.model, patch.model);
  write(KEY.extraBody, patch.extraBody);
}
```

> **动手前先确认 `settings` 表的列名**：`src/server/migrations.ts` 里 v1 的 `CREATE TABLE settings(...)`
> 是否就是 `(key, value)`。如果它还有 `updated_at` 之类的非空列，上面的 INSERT 要补上，
> 否则会在运行时炸而不是在编译期。

- [ ] **步骤 7：运行测试验证通过**

运行：`pnpm vitest run src/lib/llm-extra-body.test.ts src/server/llm/settings.test.ts`
预期：两个文件全绿

- [ ] **步骤 8：Commit**

```bash
git add src/lib/llm-extra-body.ts src/lib/llm-extra-body.test.ts src/server/llm/settings.ts src/server/llm/settings.test.ts
```

```bash
git commit -m "feat(readme-llm): 引擎配置的 env/db 双源读写与额外请求体透传"
```

---

### 任务 7：引擎接口、提示词与外部 OpenAI 兼容引擎

**接口形态用回调而不是 AsyncIterable**：既有的 `LineSplitter` 是回调式（`new LineSplitter(onLine)`），
用 async generator 去桥接它只会多一层没必要的复杂度。

**文件：**
- 创建：`src/server/llm/engine.ts`
- 创建：`src/server/llm/prompt.ts`
- 创建：`src/server/llm/external.ts` + `src/server/llm/external.test.ts`

- [ ] **步骤 1：编写失败的测试**

`src/server/llm/external.test.ts`：

```ts
import { describe, expect, it, vi } from "vitest";

import { LlmError } from "./engine";
import { createExternalEngine } from "./external";

const CONFIG = {
  baseUrl: "https://api.example.com/v1",
  apiKey: "sk-secret",
  model: "test-model",
  extraBody: null,
};

/** 造一条 SSE 流响应 */
function sseResponse(lines: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(new TextEncoder().encode(`${line}\n`));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const frame = (delta: Record<string, unknown>) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}`;

function run(engine: ReturnType<typeof createExternalEngine>, onDelta = vi.fn()) {
  return engine.run({ text: "README 片段", signal: new AbortController().signal, onDelta });
}

describe("createExternalEngine 请求形状", () => {
  it("打到 baseUrl + /chat/completions，带 Bearer 与 stream", async () => {
    const doFetch = vi.fn(() => Promise.resolve(sseResponse(["data: [DONE]"])));
    await run(createExternalEngine(CONFIG, doFetch as unknown as typeof fetch));

    const [url, init] = doFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example.com/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-secret");

    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.model).toBe("test-model");
    expect(body.stream).toBe(true);
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("extraBody 合并进请求体", async () => {
    const doFetch = vi.fn(() => Promise.resolve(sseResponse(["data: [DONE]"])));
    await run(
      createExternalEngine(
        { ...CONFIG, extraBody: { thinking: { type: "disabled" } } },
        doFetch as unknown as typeof fetch,
      ),
    );

    const body = JSON.parse(String((doFetch.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.thinking).toEqual({ type: "disabled" });
  });

  it("面板字段覆盖 extraBody 里的同名字段", async () => {
    const doFetch = vi.fn(() => Promise.resolve(sseResponse(["data: [DONE]"])));
    await run(
      createExternalEngine(
        { ...CONFIG, extraBody: { model: "用户想换的", stream: false } },
        doFetch as unknown as typeof fetch,
      ),
    );

    const body = JSON.parse(String((doFetch.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.model).toBe("test-model");
    expect(body.stream).toBe(true);
  });
});

describe("createExternalEngine 流式累积", () => {
  it("累积 content 增量并作为返回值", async () => {
    const doFetch = () =>
      Promise.resolve(
        sseResponse([
          frame({ role: "assistant", content: '{"pro' }),
          "",
          frame({ content: 'files":[]}' }),
          "data: [DONE]",
        ]),
      );

    const text = await run(createExternalEngine(CONFIG, doFetch as unknown as typeof fetch));
    expect(text).toBe('{"profiles":[]}');
  });

  it("reasoning 与 content 分开回调，正文里不混进思考", async () => {
    const onDelta = vi.fn();
    const doFetch = () =>
      Promise.resolve(
        sseResponse([
          frame({ reasoning_content: "让我想想" }),
          frame({ content: "{}" }),
          "data: [DONE]",
        ]),
      );

    const text = await run(createExternalEngine(CONFIG, doFetch as unknown as typeof fetch), onDelta);

    expect(text).toBe("{}");
    expect(onDelta).toHaveBeenCalledWith({ kind: "reasoning", text: "让我想想" });
    expect(onDelta).toHaveBeenCalledWith({ kind: "content", text: "{}" });
  });
});

describe("createExternalEngine 错误分类", () => {
  // 实测形态：限流走 HTTP 200 + JSON error 体，不是 4xx
  it("HTTP 200 但返回 JSON error 体 → rateLimited", async () => {
    const doFetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { code: "1305", message: "该模型当前访问量过大，请您稍后再试" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    const err = await run(createExternalEngine(CONFIG, doFetch as unknown as typeof fetch)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).kind).toBe("rateLimited");
  });

  it("HTTP 429 → rateLimited", async () => {
    const doFetch = () => Promise.resolve(new Response("{}", { status: 429 }));
    const err = await run(createExternalEngine(CONFIG, doFetch as unknown as typeof fetch)).catch((e: unknown) => e);
    expect((err as LlmError).kind).toBe("rateLimited");
  });

  it("HTTP 401 → unauthorized", async () => {
    const doFetch = () => Promise.resolve(new Response("{}", { status: 401 }));
    const err = await run(createExternalEngine(CONFIG, doFetch as unknown as typeof fetch)).catch((e: unknown) => e);
    expect((err as LlmError).kind).toBe("unauthorized");
  });

  it("HTTP 200 但不是 SSE、也没有 error 体 → badResponse", async () => {
    const doFetch = () =>
      Promise.resolve(new Response("整段散文，不是流", { status: 200, headers: { "content-type": "text/plain" } }));
    const err = await run(createExternalEngine(CONFIG, doFetch as unknown as typeof fetch)).catch((e: unknown) => e);
    expect((err as LlmError).kind).toBe("badResponse");
  });

  it("fetch 抛出 → network", async () => {
    const doFetch = () => Promise.reject(new Error("ECONNREFUSED"));
    const err = await run(createExternalEngine(CONFIG, doFetch as unknown as typeof fetch)).catch((e: unknown) => e);
    expect((err as LlmError).kind).toBe("network");
  });

  it("配置不全时构造即拒绝", () => {
    expect(() => createExternalEngine({ ...CONFIG, apiKey: null }, fetch)).toThrow(LlmError);
  });
});
```

- [ ] **步骤 2：运行验证失败**

运行：`pnpm vitest run src/server/llm/external.test.ts`
预期：FAIL，模块不存在

- [ ] **步骤 3：写 `src/server/llm/engine.ts`**

```ts
import { LineSplitter } from "@/core/line-splitter";
import { mergeRequestBody } from "@/lib/llm-extra-body";
import { parseSseLine } from "@/lib/chat-stream";

/**
 * LLM 抽取引擎的公共部分（批 3）
 *
 * 接口刻意**不含 `rules`**：规则引擎是同步纯函数，既不流式也不会失败，
 * 为它包一层异步接口只会让调用方多一条无意义的分支。
 *
 * **失败判定一律看响应体，不看状态码**：实测某 provider 的限流走
 * HTTP 200 + `{"error":{"code":"1305",...}}`，而它的 `json_schema` 支持是
 * HTTP 200 + 一段散文。这类服务的失败经常不走状态码。
 */

export type LlmErrorKind =
  | "notConfigured"
  | "noRunningModel"
  | "unauthorized"
  | "rateLimited"
  | "network"
  | "badResponse";

export class LlmError extends Error {
  constructor(
    readonly kind: LlmErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

export interface EngineDelta {
  kind: "reasoning" | "content";
  text: string;
}

export interface ExtractEngine {
  id: "local" | "external";
  /** 实际使用的模型标识，落库并显示在卡头——用户需要知道这份结果是谁给的 */
  model: string;
  /** 跑一次抽取，流式回调增量，返回累积的**正文**（不含 reasoning） */
  run(input: {
    text: string;
    signal: AbortSignal;
    onDelta: (delta: EngineDelta) => void;
  }): Promise<string>;
}

/** 限流的通用特征。不同 provider 措辞不同，这里只认最普遍的几种，
 *  认不出就落到 badResponse——宁可提示得笼统，也不要把认证失败说成限流 */
const RATE_LIMIT_PATTERN = /rate.?limit|too many requests|访问量过大|请求过于频繁|quota|busy/i;

/** 把一次非流式的响应体判成具体的错误。返回 null 表示这不是错误 */
export function classifyBody(status: number, bodyText: string): LlmError | null {
  if (status === 401 || status === 403) {
    return new LlmError("unauthorized", "API Key 无效或没有权限");
  }
  if (status === 429) return new LlmError("rateLimited", "服务商限流，稍后重试");

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    /* 不是 JSON，走下面的 badResponse */
  }

  const error =
    parsed !== null && typeof parsed === "object"
      ? (parsed as { error?: unknown }).error
      : undefined;

  if (error !== null && typeof error === "object") {
    const message = String((error as { message?: unknown }).message ?? "");
    if (RATE_LIMIT_PATTERN.test(message)) {
      return new LlmError("rateLimited", "服务商限流，稍后重试");
    }
    return new LlmError("badResponse", message === "" ? "服务返回了错误" : message);
  }

  if (status >= 400) return new LlmError("network", `HTTP ${status}`);
  return new LlmError("badResponse", "服务没有返回流式响应");
}

/** 面板控制的核心请求语义，排在 extraBody 之后覆盖它 */
export function buildRequestBody(
  model: string,
  prompt: string,
  extraBody: Record<string, unknown> | null,
): Record<string, unknown> {
  return mergeRequestBody(extraBody, {
    model,
    messages: [{ role: "user", content: prompt }],
    stream: true,
    // 只用 json_object：json_schema 实测会静默失效（HTTP 200 吐散文），
    // 失效不体现在状态码上，"先探测再降级"探不出来
    response_format: { type: "json_object" },
  });
}

/**
 * 共用的流式读取：POST → 逐行 parseSseLine → 回调增量 → 返回累积正文。
 * 两个引擎的差别只在 URL 与 headers，读流这一段完全一样。
 */
export async function streamCompletions(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  doFetch: typeof fetch,
  input: { signal: AbortSignal; onDelta: (delta: EngineDelta) => void },
): Promise<string> {
  let res: Response;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: input.signal,
    });
  } catch (error) {
    if (input.signal.aborted) throw new LlmError("network", "已取消");
    throw new LlmError("network", error instanceof Error ? error.message : String(error));
  }

  const contentType = res.headers.get("content-type") ?? "";
  // 不是流就一定不正常——包括 HTTP 200 携带 error 体的限流
  if (!res.ok || !contentType.includes("event-stream") || res.body === null) {
    throw classifyBody(res.status, await res.text()) ?? new LlmError("badResponse", "未知响应");
  }

  let content = "";
  const splitter = new LineSplitter((line) => {
    for (const event of parseSseLine(line)) {
      if (event.type === "reasoning") input.onDelta({ kind: "reasoning", text: event.text });
      else if (event.type === "content") {
        content += event.text;
        input.onDelta({ kind: "content", text: event.text });
      }
    }
  });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    splitter.push(decoder.decode(value, { stream: true }));
  }
  splitter.flush();

  return content;
}
```

- [ ] **步骤 4：写 `src/server/llm/prompt.ts`**

```ts
/**
 * 抽取提示词（批 3）
 *
 * 用英文写：目标 README 绝大多数是英文，同语言的指令让模型更少走神。
 *
 * 措辞的每一条都对应回证闸门的一种失败模式——**提示词是第一道防线，回证是最后一道**。
 * 只有一道时，模型会很乐意把 "0.5-0.7" 折中成 0.6 再告诉你那是作者说的。
 */
export function buildExtractPrompt(candidateText: string): string {
  return `You extract llama.cpp sampling parameters that a model author explicitly wrote in a README.

Rules:
- Only output values that literally appear in the text below. Never infer, never average a range, never convert units (do not turn "32k" into 32768), never fill in defaults.
- If the text gives a range and also a recommended value, output only the recommended value.
- If the text mentions several distinct setups (for example thinking vs non-thinking), output one entry per setup and give each a short label taken from the text.
- If the text contains no explicit parameter values, output {"profiles": []}.
- Output JSON only, no explanation, no code fence.

Output shape:
{"profiles":[{"label":"...","params":{"temp":0.6,"top_p":0.95}}]}

Text:
${candidateText}`;
}
```

- [ ] **步骤 5：写 `src/server/llm/external.ts`**

```ts
import { buildExtractPrompt } from "./prompt";
import { LlmError, buildRequestBody, streamCompletions, type ExtractEngine } from "./engine";

/**
 * 外部 OpenAI 兼容引擎（批 3）
 *
 * **必须走出站代理**：实测直连某些 provider 会 60 秒超时，经代理立刻通。
 * 调用方（extract.ts）负责把 `makeProxyFetch` 产出的 fetch 传进来——这里
 * 只认一个 `doFetch`，不自己碰代理配置，好让单测能注入桩。
 */
export interface ExternalConfig {
  baseUrl: string | null;
  apiKey: string | null;
  model: string | null;
  extraBody: Record<string, unknown> | null;
}

export function createExternalEngine(config: ExternalConfig, doFetch: typeof fetch): ExtractEngine {
  const { baseUrl, apiKey, model } = config;
  if (baseUrl === null || apiKey === null || model === null) {
    throw new LlmError("notConfigured", "外部 API 还没配置完整");
  }

  return {
    id: "external",
    model,
    run: (input) =>
      streamCompletions(
        `${baseUrl.replace(/\/+$/, "")}/chat/completions`,
        { authorization: `Bearer ${apiKey}` },
        buildRequestBody(model, buildExtractPrompt(input.text), config.extraBody),
        doFetch,
        input,
      ),
  };
}
```

- [ ] **步骤 6：运行测试验证通过**

运行：`pnpm vitest run src/server/llm/external.test.ts`
预期：PASS，11 个用例全绿

- [ ] **步骤 7：Commit**

```bash
git add src/server/llm/engine.ts src/server/llm/prompt.ts src/server/llm/external.ts src/server/llm/external.test.ts
```

```bash
git commit -m "feat(readme-llm): 引擎接口、抽取提示词与外部 OpenAI 兼容引擎"
```

---

### 任务 8：本地引擎

复用 `llamaUpstreamBase`——反代 route 与 health 采集器已经在用它，三处目标必须一致。

**文件：**
- 创建：`src/server/llm/local.ts` + `src/server/llm/local.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
import { describe, expect, it, vi } from "vitest";

import { LlmError } from "./engine";
import { createLocalEngine } from "./local";

function sseResponse(lines: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(new TextEncoder().encode(`${line}\n`));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const RUNNING = { container: "llamapad-model", model: "qwen3-27b", hostPort: 18080 };

describe("createLocalEngine", () => {
  it("打到 llamaUpstreamBase(hostPort) + /v1/chat/completions", async () => {
    const doFetch = vi.fn(() => Promise.resolve(sseResponse(["data: [DONE]"])));
    const engine = createLocalEngine(RUNNING, null, doFetch as unknown as typeof fetch);
    await engine.run({ text: "片段", signal: new AbortController().signal, onDelta: vi.fn() });

    const [url] = doFetch.mock.calls[0] as unknown as [string];
    expect(url).toBe("http://127.0.0.1:18080/v1/chat/completions");
  });

  it("不带 authorization —— 面板的 token 不该泄漏给模型容器", async () => {
    const doFetch = vi.fn(() => Promise.resolve(sseResponse(["data: [DONE]"])));
    const engine = createLocalEngine(RUNNING, null, doFetch as unknown as typeof fetch);
    await engine.run({ text: "片段", signal: new AbortController().signal, onDelta: vi.fn() });

    const [, init] = doFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("model 取运行中模型名，落库与卡头都要显示它", () => {
    const engine = createLocalEngine(RUNNING, null, fetch);
    expect(engine.model).toBe("qwen3-27b");
  });

  it("没有模型在运行时构造即拒绝，kind = noRunningModel", () => {
    expect(() => createLocalEngine(null, null, fetch)).toThrow(LlmError);
    try {
      createLocalEngine(null, null, fetch);
    } catch (e) {
      expect((e as LlmError).kind).toBe("noRunningModel");
    }
  });

  it("容器在跑但配置行已删（hostPort 为 null）同样拒绝", () => {
    try {
      createLocalEngine({ ...RUNNING, hostPort: null }, null, fetch);
    } catch (e) {
      expect((e as LlmError).kind).toBe("noRunningModel");
    }
  });

  it("extraBody 同样透传（本地也可能是推理模型）", async () => {
    const doFetch = vi.fn(() => Promise.resolve(sseResponse(["data: [DONE]"])));
    const engine = createLocalEngine(RUNNING, { enable_thinking: false }, doFetch as unknown as typeof fetch);
    await engine.run({ text: "片段", signal: new AbortController().signal, onDelta: vi.fn() });

    const [, init] = doFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).enable_thinking).toBe(false);
  });
});
```

> `llamaUpstreamBase` 读 `process.env.PANEL_LLAMA_HOST`，缺省 `127.0.0.1`。
> 测试环境不设这个变量，所以断言里是 `127.0.0.1`。

- [ ] **步骤 2：运行验证失败**

运行：`pnpm vitest run src/server/llm/local.test.ts`
预期：FAIL，模块不存在

- [ ] **步骤 3：写 `src/server/llm/local.ts`**

```ts
import { llamaUpstreamBase } from "../llamaProxy";
import type { RunningContainerInfo } from "../runtime";
import { buildExtractPrompt } from "./prompt";
import { LlmError, buildRequestBody, streamCompletions, type ExtractEngine } from "./engine";

/**
 * 本地引擎：直连当前运行中的 llama-server（批 3）
 *
 * 不经浏览器那条 `/api/v1/proxy/llama` 反代——那是给前端用的，服务端自己调用
 * 绕一圈只会多一跳。目标地址复用 `llamaUpstreamBase`，与反代 route、health
 * 采集器共用同一个拼法，三处必须一致（容器化部署时 host 是 host.docker.internal
 * 而不是 127.0.0.1，这个差异只在那一个函数里）。
 *
 * **不带 authorization**：面板的 session cookie 与 API token 都不该泄漏给模型
 * 容器，而且 llama-server 自己的 `--api-key` 校验会与之冲突（反代那边
 * REQUEST_STRIP_HEADERS 剔除 authorization 就是这个理由）。
 *
 * **会占用正在运行的模型一次推理**，与 Playground 抢槽位。UI 上必须明示。
 */
export function createLocalEngine(
  running: RunningContainerInfo | null,
  extraBody: Record<string, unknown> | null,
  doFetch: typeof fetch,
): ExtractEngine {
  if (running === null || running.hostPort === null) {
    throw new LlmError("noRunningModel", "当前没有模型在运行");
  }

  const model = running.model;
  return {
    id: "local",
    model,
    run: (input) =>
      streamCompletions(
        `${llamaUpstreamBase(running.hostPort!)}/v1/chat/completions`,
        {},
        buildRequestBody(model, buildExtractPrompt(input.text), extraBody),
        doFetch,
        input,
      ),
  };
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm vitest run src/server/llm/local.test.ts`
预期：PASS，6 个用例全绿

- [ ] **步骤 5：Commit**

```bash
git add src/server/llm/local.ts src/server/llm/local.test.ts
```

```bash
git commit -m "feat(readme-llm): 本地引擎直连运行中的 llama-server"
```

---

### 任务 9：编排

把「候选片段 → 引擎 → 解析 → 回证 → 落库」串起来，并决定这次要不要直接落库。

**文件：**
- 创建：`src/server/llm/extract.ts` + `src/server/llm/extract.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";

import { openDb, runMigrations } from "../db";
import { getReadme, readLlmCache, saveLlmCache } from "../hf/readme";
import type { ExtractEngine } from "./engine";
import { runExtract } from "./extract";

let db: Database.Database;

const BODY = "Set the temperature to 0.6 for best results. Use top_p 0.95.";

beforeEach(async () => {
  db = openDb(":memory:");
  runMigrations(db);
  await getReadme(db, "o/r", {
    hf: {},
    fetchImpl: (() => Promise.resolve(new Response(BODY, { status: 200 }))) as unknown as typeof fetch,
  });
});

/** 一个只会吐固定文本的假引擎 */
function fakeEngine(output: string, model = "fake-model"): ExtractEngine {
  return {
    id: "external",
    model,
    run: ({ onDelta }) => {
      onDelta({ kind: "content", text: output });
      return Promise.resolve(output);
    },
  };
}

describe("runExtract", () => {
  it("回证通过的字段落进结果，并首次直接落库", async () => {
    const out = await runExtract({
      db,
      repo: "o/r",
      engine: fakeEngine('{"profiles":[{"label":"R","params":{"temp":0.6}}]}'),
      signal: new AbortController().signal,
      onDelta: vi.fn(),
    });

    expect(out.hadPrevious).toBe(false);
    expect(out.result.profiles[0]!.server).toEqual({ temp: 0.6 });
    expect(JSON.parse(readLlmCache(db, "o/r")!.profiles!)).toHaveLength(1);
    expect(readLlmCache(db, "o/r")!.model).toBe("fake-model");
  });

  // D3：重跑不落库，交给用户在对比弹层里决定
  it("已有旧结果时不落库，只回结果并标 hadPrevious", async () => {
    saveLlmCache(db, "o/r", { profiles: '[{"id":"old"}]', engine: "local", model: "old-model", contentSha: "x" });

    const out = await runExtract({
      db,
      repo: "o/r",
      engine: fakeEngine('{"profiles":[{"label":"R","params":{"temp":0.6}}]}'),
      signal: new AbortController().signal,
      onDelta: vi.fn(),
    });

    expect(out.hadPrevious).toBe(true);
    expect(JSON.parse(readLlmCache(db, "o/r")!.profiles!)).toEqual([{ id: "old" }]);
  });

  it("模型吐不出合法 JSON → badResponse，不落库", async () => {
    const err = await runExtract({
      db,
      repo: "o/r",
      engine: fakeEngine("在英文句子中，要抠出 temperature…"),
      signal: new AbortController().signal,
      onDelta: vi.fn(),
    }).catch((e: unknown) => e);

    expect((err as { kind?: string }).kind).toBe("badResponse");
    expect(readLlmCache(db, "o/r")!.profiles).toBeNull();
  });

  // 「AI 没找到」不是错误：跑通了、原文里确实没有，这是正常结果，要落库
  it("解析成功但一套都没抠到 → 正常返回空结果并落库", async () => {
    const out = await runExtract({
      db,
      repo: "o/r",
      engine: fakeEngine('{"profiles":[]}'),
      signal: new AbortController().signal,
      onDelta: vi.fn(),
    });

    expect(out.result.profiles).toEqual([]);
    expect(readLlmCache(db, "o/r")!.profiles).toBe("[]");
  });

  it("落库的 contentSha 取当前 README 的 sha，供 UI 判过期", async () => {
    await runExtract({
      db,
      repo: "o/r",
      engine: fakeEngine('{"profiles":[{"label":"R","params":{"temp":0.6}}]}'),
      signal: new AbortController().signal,
      onDelta: vi.fn(),
    });

    const llm = readLlmCache(db, "o/r")!;
    expect(llm.contentSha).toBe(readReadmeCacheSha(db));
  });

  it("README 没拉过时拒绝，不去打网络", async () => {
    const err = await runExtract({
      db,
      repo: "never/fetched",
      engine: fakeEngine("{}"),
      signal: new AbortController().signal,
      onDelta: vi.fn(),
    }).catch((e: unknown) => e);

    expect((err as { kind?: string }).kind).toBe("badResponse");
  });

  it("增量原样透传给调用方（SSE 路由要往前端推）", async () => {
    const onDelta = vi.fn();
    await runExtract({
      db,
      repo: "o/r",
      engine: fakeEngine('{"profiles":[]}'),
      signal: new AbortController().signal,
      onDelta,
    });

    expect(onDelta).toHaveBeenCalledWith({ kind: "content", text: '{"profiles":[]}' });
  });
});

/** 取当前 README 的 content_sha，供上面那条断言用 */
function readReadmeCacheSha(database: Database.Database): string {
  const row = database.prepare("SELECT content_sha FROM repo_readme WHERE repo = 'o/r'").get() as {
    content_sha: string;
  };
  return row.content_sha;
}
```

- [ ] **步骤 2：运行验证失败**

运行：`pnpm vitest run src/server/llm/extract.test.ts`
预期：FAIL，模块不存在

- [ ] **步骤 3：写 `src/server/llm/extract.ts`**

```ts
import type Database from "better-sqlite3";

import { extractJson } from "@/lib/llm-json";
import { buildLlmProfiles, type LlmExtractResult } from "@/lib/llm-profiles";
import { readmeCandidates } from "@/lib/readme-candidates";
import { splitFrontmatter } from "@/lib/readme-frontmatter";
import { readLlmCache, readReadmeCache, saveLlmCache } from "../hf/readme";
import { LlmError, type EngineDelta, type ExtractEngine } from "./engine";

/**
 * 一次 LLM 抽取的完整编排（批 3）
 *
 * 五步：切候选片段 → 引擎流式跑 → 抠 JSON → 逐字段回证 → 决定落不落库。
 *
 * **落库条件是「之前没有结果」**（D3）：首次直接存，重跑不存、把结果交给
 * 前端弹对比层，由用户决定覆盖还是保留旧的。花 API 额度换来的旧结果不该被
 * 一次未经确认的重跑冲掉。
 *
 * **「一套都没抠到」不是错误**：跑通了、原文里确实没写，这是正常结果，
 * 照样落库——否则用户每次进来都会重跑一次注定为空的解析。只有「模型吐不出
 * 合法 JSON」才是错误（badResponse），那说明这个模型干不了这活。
 */

export interface ExtractOutcome {
  result: LlmExtractResult;
  /** true = 之前已有 AI 结果，本次没落库，等用户在弹层里定夺 */
  hadPrevious: boolean;
  engine: "local" | "external";
  model: string;
  /** 候选片段是否因预算被截断，UI 要如实告知 */
  truncated: boolean;
}

export async function runExtract(opts: {
  db: Database.Database;
  repo: string;
  engine: ExtractEngine;
  signal: AbortSignal;
  onDelta: (delta: EngineDelta) => void;
}): Promise<ExtractOutcome> {
  const cached = readReadmeCache(opts.db, opts.repo);
  if (cached === null || cached.content === null || cached.contentSha === null) {
    throw new LlmError("badResponse", "这个仓库还没有 README 可供解析");
  }

  const body = splitFrontmatter(cached.content).body;
  const candidates = readmeCandidates(body);

  const raw = await opts.engine.run({
    text: candidates.text,
    signal: opts.signal,
    onDelta: opts.onDelta,
  });

  const parsed = extractJson(raw);
  if (parsed === null) {
    throw new LlmError("badResponse", "模型没有返回可解析的 JSON");
  }

  // 回证用**整篇正文**而不是候选片段：片段是为了省 token 才裁的，
  // 用它回证会把"值确实在 README 里、只是不在这一段"的字段冤枉掉
  const result = buildLlmProfiles(parsed, body);

  const previous = readLlmCache(opts.db, opts.repo);
  const hadPrevious = previous !== null && previous.profiles !== null;

  if (!hadPrevious) {
    saveLlmCache(opts.db, opts.repo, {
      profiles: JSON.stringify(result.profiles),
      engine: opts.engine.id,
      model: opts.engine.model,
      contentSha: cached.contentSha,
    });
  }

  return {
    result,
    hadPrevious,
    engine: opts.engine.id,
    model: opts.engine.model,
    truncated: candidates.truncated,
  };
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm vitest run src/server/llm/extract.test.ts`
预期：PASS，7 个用例全绿

- [ ] **步骤 5：Commit**

```bash
git add src/server/llm/extract.ts src/server/llm/extract.test.ts
```

```bash
git commit -m "feat(readme-llm): 抽取编排与首次落库判定"
```

---

### 任务 10：推荐卡的 tab 判定

纯函数，把「哪些 tab 出现、默认选谁、计数怎么显示、入口链接要不要显示」这四件事从组件里摘出来。

**文件：**
- 创建：`src/lib/recommend-tabs.ts` + `src/lib/recommend-tabs.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
import { describe, expect, it } from "vitest";

import { buildRecommendTabs, defaultRecommendTab, showLlmEntry } from "./recommend-tabs";

describe("buildRecommendTabs", () => {
  it("两边都有结果时两个 tab 都在，各带计数", () => {
    expect(buildRecommendTabs(2, 1)).toEqual([
      { key: "rules", count: 2 },
      { key: "llm", count: 1 },
    ]);
  });

  // 规则 0 套时那个 tab 没有存在意义，直接不出现
  it("规则 0 套时只剩 AI tab", () => {
    expect(buildRecommendTabs(0, 1)).toEqual([{ key: "llm", count: 1 }]);
  });

  it("AI 没跑过时 tab 仍在，但不带计数", () => {
    expect(buildRecommendTabs(2, null)).toEqual([
      { key: "rules", count: 2 },
      { key: "llm", count: null },
    ]);
  });

  // 跑完是 0 套与没跑过在 tab 上看起来一样：计数只在有东西时才显示
  it("AI 跑完 0 套同样不带计数", () => {
    expect(buildRecommendTabs(2, 0)).toEqual([
      { key: "rules", count: 2 },
      { key: "llm", count: null },
    ]);
  });

  it("两边都空时只剩 AI tab、无计数 —— 这正是最需要 AI 的场景", () => {
    expect(buildRecommendTabs(0, null)).toEqual([{ key: "llm", count: null }]);
  });
});

describe("defaultRecommendTab", () => {
  it("有规则结果就落规则 tab —— 它零成本且已经在那了", () => {
    expect(defaultRecommendTab(2)).toBe("rules");
  });

  it("规则 0 套时落 AI tab", () => {
    expect(defaultRecommendTab(0)).toBe("llm");
  });
});

describe("showLlmEntry", () => {
  it("两个 tab 都在时显示入口链接", () => {
    expect(showLlmEntry(buildRecommendTabs(2, null))).toBe(true);
  });

  // 只有 AI tab 时用户已经在那一页上了，再放一个"去 AI 解析"的链接是噪声
  it("只剩 AI tab 时隐藏入口链接", () => {
    expect(showLlmEntry(buildRecommendTabs(0, null))).toBe(false);
  });
});
```

- [ ] **步骤 2：运行验证失败**

运行：`pnpm vitest run src/lib/recommend-tabs.test.ts`
预期：FAIL，模块不存在

- [ ] **步骤 3：写 `src/lib/recommend-tabs.ts`**

```ts
/**
 * 「推荐模型配置」卡的 tab 判定（批 3）
 *
 * 与 logs-tabs.ts / settings-tabs.ts 同形态：判定是纯函数，组件只负责渲染。
 *
 * 三条规则，都来自同一个取向——**tab 不该展示"这里什么都没有"**：
 * - 规则 0 套时那个 tab 整个不出现（而不是出现一个空 tab）
 * - 计数只在真有结果时显示：AI 没跑过与跑完 0 套在 tab 上看起来一样，
 *   区别在面板内部的文案里讲，那里有足够的地方把话说清楚
 * - 只剩一个 tab 时隐藏「不满意？用 LLM 解析」入口——用户已经在那一页上了
 */

export type RecommendTab = "rules" | "llm";

export interface RecommendTabItem {
  key: RecommendTab;
  /** null = 不显示数字 */
  count: number | null;
}

/**
 * @param rulesCount 规则抽取器产出的套数
 * @param llmCount   AI 结果套数；**null 表示从没跑过**，与跑完 0 套是两回事
 */
export function buildRecommendTabs(rulesCount: number, llmCount: number | null): RecommendTabItem[] {
  const tabs: RecommendTabItem[] = [];
  if (rulesCount > 0) tabs.push({ key: "rules", count: rulesCount });
  tabs.push({ key: "llm", count: llmCount !== null && llmCount > 0 ? llmCount : null });
  return tabs;
}

/** 有规则结果就落规则 tab：它零成本、进页面就在那了；没有才落 AI */
export function defaultRecommendTab(rulesCount: number): RecommendTab {
  return rulesCount > 0 ? "rules" : "llm";
}

/** 入口链接只在两个 tab 并存时有意义 */
export function showLlmEntry(tabs: readonly RecommendTabItem[]): boolean {
  return tabs.length > 1;
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm vitest run src/lib/recommend-tabs.test.ts`
预期：PASS，9 个用例全绿

- [ ] **步骤 5：Commit**

```bash
git add src/lib/recommend-tabs.ts src/lib/recommend-tabs.test.ts
```

```bash
git commit -m "feat(readme-llm): 推荐卡 tab 判定纯函数"
```

---

### 任务 11：抽取路由（SSE）与覆盖落库路由

**协议是面板自己的，不是 OpenAI 的**：前端不该去解析 provider 的帧格式，服务端已经解析过一遍了。

```
data: {"type":"delta","kind":"content","text":"…"}
data: {"type":"done","result":{…},"hadPrevious":false,"engine":"external","model":"…","truncated":false,"raw":"…"}
data: {"type":"error","kind":"rateLimited","message":"服务商限流，稍后重试"}
```

**落库只有服务端一条路径**：`save` 路由收的是模型输出的原始文本 `raw`，服务端重跑一遍
解析与回证再落库。前端篡改 `raw` 也绕不过回证——伪造的值不可能出现在 README 原文里。

**文件：**
- 创建：`src/app/api/v1/repos/[id]/readme/llm/route.ts`
- 创建：`src/app/api/v1/repos/[id]/readme/llm/save/route.ts`

- [ ] **步骤 1：写抽取路由**

`src/app/api/v1/repos/[id]/readme/llm/route.ts`：

```ts
import { NextResponse } from "next/server";

import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { getDockerAdapter } from "@/server/docker";
import { makeProxyFetch } from "@/server/hf/client";
import { resolveProxy } from "@/server/hf/settings";
import { LlmError, type EngineDelta } from "@/server/llm/engine";
import { runExtract } from "@/server/llm/extract";
import { createExternalEngine } from "@/server/llm/external";
import { createLocalEngine } from "@/server/llm/local";
import { resolveLlmConfig } from "@/server/llm/settings";
import { getProfile } from "@/server/repoProfiles";
import { getRunningContainerInfo } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/repos/:id/readme/llm：用 LLM 再解析一遍 README（批 3）。
 *
 * SSE 响应，帧协议见本任务的计划说明。**只有用户显式点击才会走到这里**——
 * 没有任何自动路径（进页面、切 tab、刷新 README）通向本路由。
 *
 * 结果落库与否由 runExtract 决定：首次直接落，重跑不落、交给 save 路由。
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "id 非法" }, { status: 400 });

  const db = getDb();
  const profile = getProfile(db, id);
  if (profile === null) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  const config = resolveLlmConfig(db);
  const encoder = new TextEncoder();
  const controller = new AbortController();
  // 客户端断开（用户点了取消 / 关了页面）要把上游请求一并掐掉，
  // 否则本地引擎那次推理会继续占着模型槽位跑到底
  req.signal.addEventListener("abort", () => controller.abort());

  const stream = new ReadableStream<Uint8Array>({
    async start(sink) {
      const send = (payload: unknown): void => {
        sink.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };

      try {
        const engine =
          config.engine === "local"
            ? createLocalEngine(
                await getRunningContainerInfo(db, getDockerAdapter()),
                config.extraBody,
                fetch,
              )
            : config.engine === "external"
              ? createExternalEngine(config, proxyFetch(db))
              : (() => {
                  throw new LlmError("notConfigured", "AI 解析未启用");
                })();

        let raw = "";
        const outcome = await runExtract({
          db,
          repo: profile.repo,
          engine,
          signal: controller.signal,
          onDelta: (delta: EngineDelta) => {
            if (delta.kind === "content") raw += delta.text;
            send({ type: "delta", kind: delta.kind, text: delta.text });
          },
        });

        send({ type: "done", ...outcome, raw });
      } catch (error) {
        const kind = error instanceof LlmError ? error.kind : "network";
        const message = error instanceof Error ? error.message : String(error);
        send({ type: "error", kind, message });
      } finally {
        sink.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}

/** 外部引擎必须走出站代理：实测直连会超时（规格 §13.1） */
function proxyFetch(db: ReturnType<typeof getDb>): typeof fetch {
  const proxy = resolveProxy(db);
  return proxy ? makeProxyFetch(proxy) : fetch;
}
```

> **两处要先确认再写**：
> 1. `resolveProxy` 在 `src/server/hf/settings.ts` 里的实际导出名与签名——那个文件里
>    有 `effectiveProxy` 之类的内部函数，未必以这个名字导出。若没有导出，就照
>    `hf/client.ts` 的 `resolveHfOptions()` 取代理（它返回的 `HfOptions` 带 `proxy`），
>    并把这里改成 `await resolveHfOptions()`。
> 2. `getDockerAdapter` 的实际导出位置（`src/server/docker.ts` 或 `locators.ts`）。
>    照 `src/app/api/v1/proxy/llama/[[...path]]/route.ts` 里取运行容器那段的写法。

- [ ] **步骤 2：写覆盖落库路由**

`src/app/api/v1/repos/[id]/readme/llm/save/route.ts`：

```ts
import { NextResponse } from "next/server";
import { z } from "zod";

import { extractJson } from "@/lib/llm-json";
import { buildLlmProfiles } from "@/lib/llm-profiles";
import { splitFrontmatter } from "@/lib/readme-frontmatter";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { readReadmeCache, saveLlmCache } from "@/server/hf/readme";
import { getProfile } from "@/server/repoProfiles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  /** 模型输出的原始正文，来自 SSE 的 done 帧 */
  raw: z.string().min(1),
  engine: z.enum(["local", "external"]),
  model: z.string().min(1),
});

/**
 * POST /api/v1/repos/:id/readme/llm/save：用户在对比弹层里点了「覆盖」（批 3）。
 *
 * **收原始文本而不是装配好的 profiles**：落库前服务端重跑一遍解析与回证，
 * 前端篡改 `raw` 也绕不过——伪造的值不可能字面出现在 README 原文里。
 * 落库路径只有这一条和 runExtract 里的首次落库，两条都过回证。
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "id 非法" }, { status: 400 });

  const db = getDb();
  const profile = getProfile(db, id);
  if (profile === null) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  const parsedBody = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsedBody.success) return NextResponse.json({ error: "请求体非法" }, { status: 400 });

  const cached = readReadmeCache(db, profile.repo);
  if (cached === null || cached.content === null || cached.contentSha === null) {
    return NextResponse.json({ error: "NO_README" }, { status: 409 });
  }

  const json = extractJson(parsedBody.data.raw);
  if (json === null) return NextResponse.json({ error: "UNPARSABLE" }, { status: 422 });

  const body = splitFrontmatter(cached.content).body;
  const result = buildLlmProfiles(json, body);

  saveLlmCache(db, profile.repo, {
    profiles: JSON.stringify(result.profiles),
    engine: parsedBody.data.engine,
    model: parsedBody.data.model,
    contentSha: cached.contentSha,
  });

  return NextResponse.json({ ok: true, count: result.profiles.length });
}
```

- [ ] **步骤 3：验证**

```bash
pnpm run lint && npx tsc --noEmit
```

预期：零错误。路由是薄壳（鉴权 + 取配置 + 调编排），逻辑都在已单测过的模块里，
按仓库惯例不为它单独写测试——`llamaProxy.test.ts` 的头注说明了同样的取舍。

- [ ] **步骤 4：Commit**

```bash
git add "src/app/api/v1/repos/[id]/readme/llm"
```

```bash
git commit -m "feat(readme-llm): 抽取 SSE 路由与覆盖落库路由"
```

---

### 任务 12：设置路由与 README 响应扩展

**文件：**
- 创建：`src/app/api/v1/settings/llm/route.ts`
- 创建：`src/app/api/v1/settings/llm/test/route.ts`
- 修改：`src/app/api/v1/repos/[id]/readme/route.ts`

- [ ] **步骤 1：写设置路由**

`src/app/api/v1/settings/llm/route.ts`，形态照 `settings/hf/route.ts`：

```ts
import { NextResponse } from "next/server";
import { z } from "zod";

import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { getDockerAdapter } from "@/server/docker";
import { getLlmSettings, saveLlmSettings } from "@/server/llm/settings";
import { getRunningContainerInfo } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const patchSchema = z.object({
  engine: z.enum(["none", "local", "external"]).optional(),
  baseUrl: z.string().url().nullable().optional(),
  apiKey: z.string().min(1).nullable().optional(),
  model: z.string().min(1).nullable().optional(),
  extraBody: z.string().nullable().optional(),
});

/**
 * GET/PUT /api/v1/settings/llm（批 3）：LLM 解析引擎与外部凭据。
 *
 * - GET 回 `LlmSettingsSnapshot`：**API Key 明文永不回传**，只回
 *   `keySet` / `keyTail`（尾 4 位）/ `keySource`（env|db|null）。
 *   env 来源的字段在 UI 上应表现为只读——那是部署方的决定，面板改不动。
 * - PUT 接受任意子集；某项传 null 表示清除 db 里那份（env 若有仍然生效）。
 *   `extraBody` 只校验「是不是合法 JSON 对象」，不校验语义——它是给 provider
 *   专属字段用的口子，面板不可能知道每家都支持什么。
 */
export async function GET(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const db = getDb();
  // 顺带回「当前是否有模型在运行」：AI 面板要用它判断本地引擎可不可用，
  // 服务端手上就有 getRunningContainerInfo，比让前端再打一次请求划算
  const running = await getRunningContainerInfo(db, getDockerAdapter());
  return NextResponse.json({
    ...getLlmSettings(db),
    hasRunningModel: running !== null && running.hostPort !== null,
  });
}

export async function PUT(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "请求体非法" }, { status: 400 });

  const { extraBody } = parsed.data;
  if (typeof extraBody === "string" && extraBody.trim() !== "") {
    try {
      const value: unknown = JSON.parse(extraBody);
      if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
    } catch {
      return NextResponse.json({ error: "额外请求体必须是一个 JSON 对象" }, { status: 400 });
    }
  }

  saveLlmSettings(getDb(), parsed.data);
  return NextResponse.json(getLlmSettings(getDb()));
}
```

- [ ] **步骤 2：写测试连接路由**

`src/app/api/v1/settings/llm/test/route.ts`：发一次最小的非流式请求，**不做抽取**。

```ts
import { NextResponse } from "next/server";

import { mergeRequestBody } from "@/lib/llm-extra-body";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { makeProxyFetch } from "@/server/hf/client";
import { classifyBody } from "@/server/llm/engine";
import { resolveLlmConfig } from "@/server/llm/settings";
import { resolveHfOptions } from "@/server/hf/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/settings/llm/test（批 3）：测一次外部 API 连通性。
 *
 * 刻意发一个**最小的非流式**请求（一句 ping、max_tokens 极小），不跑真正的抽取——
 * 测连接不该花掉一次完整抽取的额度。判定同样看响应体不看状态码：实测限流走
 * HTTP 200 + error 体。
 */
export async function POST(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const config = resolveLlmConfig(getDb());
  if (config.baseUrl === null || config.apiKey === null || config.model === null) {
    return NextResponse.json({ ok: false, kind: "notConfigured" }, { status: 200 });
  }

  const proxy = (await resolveHfOptions()).proxy;
  const doFetch = proxy ? makeProxyFetch(proxy) : fetch;

  try {
    const res = await doFetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify(
        mergeRequestBody(config.extraBody, {
          model: config.model,
          messages: [{ role: "user", content: "ping" }],
          stream: false,
          max_tokens: 4,
        }),
      ),
    });

    const text = await res.text();
    const error = classifyBody(res.status, text);
    // classifyBody 对「200 且不是流」也会给 badResponse，但非流式请求本就不该是流，
    // 所以这里只在真有 error 体或状态码异常时才算失败
    if (res.ok && !text.includes('"error"')) {
      return NextResponse.json({ ok: true, model: config.model });
    }
    return NextResponse.json({ ok: false, kind: error?.kind ?? "badResponse", message: error?.message });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      kind: "network",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
```

- [ ] **步骤 3：README 响应加 `llm` 段**

`src/app/api/v1/repos/[id]/readme/route.ts` 的返回体末尾追加一个字段，并同步更新
该文件顶部 JSDoc 里的响应形状说明：

```ts
  const llm = readLlmCache(db, profile.repo);

  return NextResponse.json({
    // …既有字段原样不动…
    profiles: result.profiles === null ? [] : (JSON.parse(result.profiles) as unknown[]),
    profilesEngine: result.profilesEngine,
    /**
     * AI 解析结果（批 3）。`profiles: null` 表示**从没跑过**，与跑完 0 套
     * （`[]`）是两回事——前者 tab 上不显示计数并给「开始解析」，后者要说
     * 「AI 也没找到」。
     *
     * `stale` = 解析当时的 README 与现在的不是同一份。**不删结果只标过期**：
     * 花 API 额度换来的东西不替用户丢。
     */
    llm: llm === null || llm.profiles === null
      ? null
      : {
          profiles: JSON.parse(llm.profiles) as unknown[],
          engine: llm.engine,
          model: llm.model,
          parsedAt: llm.parsedAt,
          stale: llm.contentSha !== result.contentSha,
        },
    error: result.error,
  });
```

顶部 import 补 `readLlmCache`：

```ts
import { getReadme, readLlmCache } from "@/server/hf/readme";
```

- [ ] **步骤 4：验证**

```bash
pnpm run lint && npx tsc --noEmit && pnpm test
```

预期：零错误、测试全绿。

- [ ] **步骤 5：Commit**

```bash
git add src/app/api/v1/settings/llm "src/app/api/v1/repos/[id]/readme/route.ts"
```

```bash
git commit -m "feat(readme-llm): 引擎设置路由与 README 响应的 AI 结果段"
```

---

### 任务 13：推荐卡外壳（卡头 + tab + 入口）

现在的推荐区是 `profiles.length > 0` 才渲染的一张卡。**必须改成有 README 就总是渲染**——否则规则 0 套（bartowski / DeepSeek-R1 这类）时恰好没有 AI 入口，而那正是最需要它的场景。

卡头三态：

```
规则 2 套 + AI 1 套
│  推荐模型配置   [README解析(2)][AI解析(1)]    不满意？用 LLM 解析 ↗ │

规则 0 套（README解析 tab 不出现，右上角链接也隐藏）
│  推荐模型配置   [AI解析]                                            │

规则 2 套 + AI 没跑过（AI tab 不带计数）
│  推荐模型配置   [README解析(2)][AI解析]       不满意？用 LLM 解析 ↗ │
```

**文件：**
- 创建：`src/components/models/recommend-tabs-card.tsx`
- 修改：`src/app/(panel)/models/repos/[id]/readme-view.tsx`

- [ ] **步骤 1：写外壳组件**

`src/components/models/recommend-tabs-card.tsx`，用仓库现成的 `@/components/ui/tabs`
（`Tabs` / `TabsList` / `TabsTrigger` / `TabsContent`，图表弹层等 3 处在用）：

```tsx
"use client";

import { useState } from "react";
import { Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  buildRecommendTabs,
  defaultRecommendTab,
  showLlmEntry,
  type RecommendTab,
} from "@/lib/recommend-tabs";

/**
 * 「推荐模型配置」卡（批 3）
 *
 * 规则结果与 AI 结果**分两个 tab**，不混排：规则是零成本、进页面就有的；
 * AI 是用户主动花代价换的。混排会模糊这个区别，而这个区别正是用户决定
 * 要不要信任某张卡的依据。
 *
 * **有 README 就渲染这张卡**，即使一套推荐都没有——规则 0 套时的空态
 * 恰恰是 AI 最该出场的地方，把整张卡藏掉等于把入口也藏掉。
 *
 * tab 状态是组件内 state，不进 URL：侧栏 `?view=` 已经占了一级，再叠一个
 * 只为阅读态的参数不值当；入口链接是同组件内回调，不需要 URL 中转。
 */
export function RecommendTabsCard({
  rulesCount,
  llmCount,
  rulesPanel,
  llmPanel,
}: {
  rulesCount: number;
  /** null = AI 从没跑过；0 = 跑完没找到。两者在 tab 上一样，在面板里说法不同 */
  llmCount: number | null;
  rulesPanel: React.ReactNode;
  llmPanel: React.ReactNode;
}) {
  const t = useTranslations("pages.repos");
  const tabs = buildRecommendTabs(rulesCount, llmCount);
  const [tab, setTab] = useState<RecommendTab>(() => defaultRecommendTab(rulesCount));

  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <Tabs value={tab} onValueChange={(next) => setTab(next as RecommendTab)}>
          <div className="flex items-center gap-3">
            <h2 className="shrink-0 text-sm font-semibold">{t("recommendCardTitle")}</h2>
            <TabsList>
              {tabs.map((item) => (
                <TabsTrigger key={item.key} value={item.key}>
                  {t(item.key === "rules" ? "recommendTabRules" : "recommendTabLlm")}
                  {item.count !== null && (
                    <span className="ml-1 text-muted-foreground">({item.count})</span>
                  )}
                </TabsTrigger>
              ))}
            </TabsList>
            {showLlmEntry(tabs) && (
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto shrink-0 gap-1 text-muted-foreground"
                onClick={() => setTab("llm")}
              >
                <Sparkles className="size-3.5" />
                {t("recommendTryLlm")}
              </Button>
            )}
          </div>

          {/* 两个面板都保持挂载：AI 面板里可能正在流式生成，切走就丢了 */}
          <TabsContent value="rules" keepMounted>{rulesPanel}</TabsContent>
          <TabsContent value="llm" keepMounted>{llmPanel}</TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
```

> **`keepMounted` 要先确认**：打开 `src/components/ui/tabs.tsx` 看 `TabsContent`
> 是否支持这个 prop。Base UI 的 Tabs 一般有 `keepMounted`；**如果没有**，就不用
> `TabsContent`，改成自己用 `hidden` 控制两个面板的显隐：
> ```tsx
> <div hidden={tab !== "rules"}>{rulesPanel}</div>
> <div hidden={tab !== "llm"}>{llmPanel}</div>
> ```
> 不能让面板卸载——AI 面板正在流式生成时切走一次就前功尽弃。

- [ ] **步骤 2：验证**

```bash
pnpm run lint && npx tsc --noEmit && pnpm run build
```

预期：零错误。**这一步只交付外壳组件本身**，接进页面是任务 14 的事——
外壳要用的 `LlmExtractPanel` 还不存在，现在接会编译不过。

- [ ] **步骤 3：Commit**

```bash
git add src/components/models/recommend-tabs-card.tsx
```

```bash
git commit -m "feat(readme-llm): 推荐卡的 tab 外壳与卡头三态"
```

---

### 任务 14：AI 解析面板（四态 + 流式）

**文件：**
- 创建：`src/components/models/llm-extract-panel.tsx`
- 修改：`src/app/(panel)/models/repos/[id]/readme-view.tsx`（接入，见任务 13 步骤 2）

四种状态：

```
未跑过 ── 说明这一步会做什么、多久、消耗什么 + [开始解析]
解析中 ── 等宽滚动区显示流式正文（自动滚底）+ [取消]
有结果 ── AI 推荐卡 + 丢弃计数 + [重新解析]
不可用 ── 三种原因分别直说，不给按钮
```

- [ ] **步骤 1：写组件**

```tsx
"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Loader2, Sparkles, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";

import type { ServerConfig } from "@/core/schemas";
import { RecommendProfileCard } from "@/components/models/recommend-profile-card";
import { Button } from "@/components/ui/button";
import { LineSplitter } from "@/core/line-splitter";
import { apiFetch } from "@/lib/api";
import type { RecommendedProfile } from "@/lib/readme-params";

/**
 * AI 解析面板（批 3）
 *
 * **没有任何自动路径通向请求**：进页面、切 tab 都不发。只有点「开始解析 /
 * 重新解析」才发——外部 API 每次调用都花钱，"顺手跑一下"意味着用户只是想
 * 看看这个 tab 长什么样就产生了消费。
 *
 * 流式帧是面板自己的协议（`{type:"delta"|"done"|"error"}`），不是 provider 的——
 * 服务端已经解析过一遍 OpenAI 帧了，前端不该再解析一次。
 */

interface EngineState {
  engine: "none" | "local" | "external";
  externalReady: boolean;
  missing: string[];
  hasRunningModel: boolean;
}

type Phase =
  | { kind: "idle" }
  | { kind: "streaming"; text: string }
  | { kind: "error"; message: string };

export function LlmExtractPanel({ repoId, effective, repoBaseName, cached, onApply, onSaveAsPreset }: {
  repoId: number;
  effective: ServerConfig;
  repoBaseName: string;
  cached: { profiles: unknown[]; model: string | null; parsedAt: number | null; stale: boolean } | null;
  onApply: (profileId: string, server: Partial<ServerConfig>) => void;
  onSaveAsPreset: (server: Partial<ServerConfig>, name: string) => void;
}) {
  const t = useTranslations("pages.repos");
  const [engineState, setEngineState] = useState<EngineState | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [profiles, setProfiles] = useState<RecommendedProfile[]>(
    () => (cached?.profiles ?? []) as RecommendedProfile[],
  );
  const [stats, setStats] = useState<{ offered: number; dropped: number } | null>(null);
  const [pendingOverwrite, setPendingOverwrite] = useState<{
    raw: string; engine: string; model: string; profiles: RecommendedProfile[];
  } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  // 引擎状态只读一次配置，不发任何 LLM 请求
  useEffect(() => {
    let alive = true;
    void (async () => {
      const res = await apiFetch("/api/v1/settings/llm").catch(() => null);
      if (!alive || res === null || !res.ok) return;
      // 一次请求拿全：GET /api/v1/settings/llm 顺带回了 hasRunningModel（任务 12）
      const s = (await res.json()) as EngineState;
      setEngineState(s);
    })();
    return () => { alive = false; };
  }, []);

  async function start(): Promise<void> {
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase({ kind: "streaming", text: "" });
    setStats(null);

    try {
      const res = await apiFetch(`/api/v1/repos/${repoId}/readme/llm`, {
        method: "POST",
        signal: controller.signal,
      });
      if (!res.ok || res.body === null) throw new Error(`HTTP ${res.status}`);

      let acc = "";
      const splitter = new LineSplitter((line) => {
        if (!line.startsWith("data: ")) return;
        const frame = JSON.parse(line.slice(6)) as Record<string, unknown>;

        if (frame.type === "delta" && frame.kind === "content") {
          acc += String(frame.text);
          setPhase({ kind: "streaming", text: acc });
        } else if (frame.type === "error") {
          setPhase({ kind: "error", message: t(`llmError.${String(frame.kind)}`) });
        } else if (frame.type === "done") {
          const result = frame.result as { profiles: RecommendedProfile[]; offered: number; dropped: number };
          setStats({ offered: result.offered, dropped: result.dropped });
          if (frame.hadPrevious === true) {
            setPendingOverwrite({
              raw: String(frame.raw),
              engine: String(frame.engine),
              model: String(frame.model),
              profiles: result.profiles,
            });
          } else {
            setProfiles(result.profiles);
          }
          setPhase({ kind: "idle" });
        }
      });

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        splitter.push(decoder.decode(value, { stream: true }));
      }
      splitter.flush();
    } catch (error) {
      if (!controller.signal.aborted) setPhase({ kind: "error", message: t("llmError.network") });
      else setPhase({ kind: "idle" });
    } finally {
      abortRef.current = null;
    }
  }

  // 流式时自动滚底
  useEffect(() => {
    if (phase.kind === "streaming" && logRef.current !== null) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [phase]);

  const unavailable = describeUnavailable(engineState);
  // …四态渲染，见步骤 2…
}
```

- [ ] **步骤 2：四态渲染与不可用判定**

```tsx
/** 引擎不可用的三种原因，各自有独立的话要说 */
function describeUnavailable(state: EngineState | null): "disabled" | "incomplete" | "noModel" | null {
  if (state === null) return null;
  if (state.engine === "none") return "disabled";
  if (state.engine === "external" && !state.externalReady) return "incomplete";
  if (state.engine === "local" && !state.hasRunningModel) return "noModel";
  return null;
}
```

渲染分支（按优先级）：

```tsx
  if (unavailable === "disabled") {
    return (
      <Notice text={t("llmDisabled")} action={{ href: "/settings?tab=runtime", label: t("llmGoSettings") }} />
    );
  }
  if (unavailable === "incomplete") {
    return (
      <Notice
        text={t("llmIncomplete", { fields: (engineState?.missing ?? []).map((m) => t(`llmField.${m}`)).join("、") })}
        action={{ href: "/settings?tab=runtime", label: t("llmGoSettings") }}
      />
    );
  }
  if (unavailable === "noModel") {
    return <Notice text={t("llmNoRunningModel")} action={{ href: "/models", label: t("llmGoModels") }} />;
  }

  if (phase.kind === "streaming") {
    return (
      <div className="flex flex-col gap-3">
        <div ref={logRef} className="max-h-48 overflow-y-auto rounded-md border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap">
          {phase.text === "" ? t("llmWaiting") : phase.text}
        </div>
        <Button size="sm" variant="outline" className="self-end" onClick={() => abortRef.current?.abort()}>
          {t("llmCancel")}
        </Button>
      </div>
    );
  }

  if (profiles.length === 0) {
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="text-sm text-muted-foreground">
          {stats === null ? t("llmIntro") : t("llmFoundNothing")}
        </p>
        {phase.kind === "error" && <p className="text-xs text-destructive">{phase.message}</p>}
        <Button size="sm" onClick={() => void start()}>
          <Sparkles className="size-3.5" />
          {stats === null ? t("llmStart") : t("llmRerun")}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {cached?.stale === true && <p className="text-xs text-muted-foreground">{t("llmStale")}</p>}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {profiles.map((profile) => (
          <RecommendProfileCard
            key={profile.id}
            profile={profile}
            effective={effective}
            repoBaseName={repoBaseName}
            modelLabel={cached?.model ?? undefined}
            onApply={(server) => onApply(profile.id, server)}
            onSaveAsPreset={onSaveAsPreset}
          />
        ))}
      </div>
      {stats !== null && stats.dropped > 0 && (
        <p className="text-xs text-muted-foreground">
          {t("llmDropped", { offered: stats.offered, dropped: stats.dropped })}
        </p>
      )}
      {phase.kind === "error" && <p className="text-xs text-destructive">{phase.message}</p>}
      <Button size="sm" variant="outline" className="self-end" onClick={() => void start()}>
        {t("llmRerun")}
      </Button>
    </div>
  );
```

`Notice` 是本文件内的一个小组件（图标 + 一句话 + 一个出口按钮），照
`readme-view.tsx` 里 `readmeUnauthorizedTitle` 那块的形态写，用
`nativeButton={false} render={<Link href={…} />}`——本仓 `Button` 是 Base UI
形态，**没有 `asChild`**。

> **动态 i18n 键**：`t(\`llmError.${kind}\`)` 这种拼接键有些 lint 配置会拒。
> 若 `pnpm run lint` 报错，改成显式映射：
> ```ts
> const ERROR_KEY: Record<string, string> = {
>   notConfigured: "llmError.notConfigured", noRunningModel: "llmError.noRunningModel",
>   unauthorized: "llmError.unauthorized", rateLimited: "llmError.rateLimited",
>   network: "llmError.network", badResponse: "llmError.badResponse",
> };
> ```
> 顺带的好处：后端加了新 kind 而前端没跟上时，这里能落到一个兜底文案而不是
> 渲染出一个原始键名。

- [ ] **步骤 3：接进 `readme-view.tsx`**

把现在这一段：

```tsx
      {data.profiles.length > 0 && (
        <Card>
          <CardContent className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold">{t("recommendFound", { count: data.profiles.length })}</h2>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {(data.profiles as RecommendedProfile[]).map((profile) => (…))}
            </div>
          </CardContent>
        </Card>
      )}
```

换成（注意去掉了 `length > 0` 的外层条件）：

```tsx
      <RecommendTabsCard
        rulesCount={data.profiles.length}
        llmCount={data.llm === null ? null : data.llm.profiles.length}
        rulesPanel={
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {(data.profiles as RecommendedProfile[]).map((profile) => (
              <RecommendProfileCard
                key={profile.id}
                profile={profile}
                effective={effective}
                repoBaseName={repoBaseName}
                onApply={(server) => onApplyRecommend(profile.id, server)}
                onSaveAsPreset={(server, name) => setSavePreset({ server, name })}
              />
            ))}
          </div>
        }
        llmPanel={
          <LlmExtractPanel
            repoId={repoId}
            effective={effective}
            repoBaseName={repoBaseName}
            cached={data.llm}
            onApply={onApplyRecommend}
            onSaveAsPreset={(server, name) => setSavePreset({ server, name })}
          />
        }
      />
```

`ReadmeResponse` 接口补上 `llm` 字段（与任务 12 的响应逐字段对齐）：

```ts
export interface LlmSection {
  profiles: unknown[];
  engine: string | null;
  model: string | null;
  parsedAt: number | null;
  /** 解析当时的 README 与现在的不是同一份 */
  stale: boolean;
}

export interface ReadmeResponse {
  // …既有字段…
  /** null = 从没跑过 AI 解析 */
  llm: LlmSection | null;
}
```

- [ ] **步骤 4：验证**

```bash
pnpm run lint && npx tsc --noEmit && pnpm run build
```

预期：零错误、构建成功。

- [ ] **步骤 5：Commit**

```bash
git add src/components/models/llm-extract-panel.tsx "src/app/(panel)/models/repos/[id]/readme-view.tsx"
```

```bash
git commit -m "feat(readme-llm): 推荐卡 tab 外壳与 AI 解析面板"
```

---

### 任务 15：推荐卡支持 AI 来源与命中句展开

AI 卡比规则卡多两样东西：来源徽章「AI 解析」+ 模型名，和每个字段旁可展开的命中原文句。

```
   ☑ temp  0.8 → 0.6   ▾ 原文
      "Set the temperature within the range of 0.5-0.7 (0.6 is
       recommended) to prevent endless repetitions."
```

**文件：**
- 修改：`src/components/models/recommend-profile-card.tsx`

- [ ] **步骤 1：补来源徽章**

现在的映射表刻意留了个缺口（注释写着「`llm` 来源尚未有抽取器产出」），现在补上：

```ts
const SOURCE_BADGE_KEY: Partial<Record<RecommendedProfile["source"], string>> = {
  "cli-block": "recommendSourceCli",
  "kv-list": "recommendSourceKv",
  llm: "recommendSourceLlm",
};
```

同时把注释改掉——它现在描述的是已经不成立的状态。

- [ ] **步骤 2：加 `modelLabel` prop 与命中句展开**

props 增加一项：

```ts
  /** AI 卡的模型名，显示在来源徽章旁。规则卡不传 */
  modelLabel?: string;
```

卡头徽章那行后面追加：

```tsx
        {modelLabel !== undefined && (
          <span className="text-[11px] text-muted-foreground">· {modelLabel}</span>
        )}
```

每一行参数的右侧，当 `profile.hits?.[row.field]` 存在时挂一个折叠。用原生
`<details>/<summary>`——本仓没有 Collapsible 组件，既有的「出处」折叠就是这么写的：

```tsx
{profile.hits?.[row.field] !== undefined && (
  <details className="mt-1">
    <summary className="cursor-pointer text-[11px] text-muted-foreground">
      {t("recommendHitSource")}
    </summary>
    <p className="mt-1 rounded bg-muted/50 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
      {profile.hits[row.field]}
    </p>
  </details>
)}
```

> **命中句本身是 README 的原文片段，属于外部不可信输入。** 这里用纯文本渲染
> （`{}` 插值，React 自动转义），**不要**经 `Markdown` 组件、更不要开 `allowHtml`——
> 那条路径的 XSS 边界由 `lib/markdown-sanitize.ts` 守，而这里根本不需要走进去。

- [ ] **步骤 3：验证**

```bash
pnpm run lint && npx tsc --noEmit && pnpm run build
```

- [ ] **步骤 4：Commit**

```bash
git add src/components/models/recommend-profile-card.tsx
```

```bash
git commit -m "feat(readme-llm): 推荐卡支持 AI 来源徽章与逐字段命中原文"
```

---

### 任务 16：重跑覆盖对比弹层

首次直接落库，重跑才弹（D3）。左右对比，两个按钮：「覆盖」「保留旧的」。

**文件：**
- 创建：`src/components/models/llm-diff-dialog.tsx`
- 修改：`src/components/models/llm-extract-panel.tsx`（接上任务 14 里已经留好的 `pendingOverwrite`）

- [ ] **步骤 1：写弹层**

```tsx
"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { apiFetch } from "@/lib/api";
import { toast } from "@/components/toast-store";
import type { RecommendedProfile } from "@/lib/readme-params";

/**
 * 重跑结果的覆盖确认（批 3）
 *
 * 首次解析直接落库，只有重跑才走到这里——那时用户手上已经有一份花过代价的
 * 结果，新的未必更好，得让他自己看着办。
 *
 * **落库不在这里发生**：点「覆盖」只是把模型输出的原始文本回传给
 * `/readme/llm/save`，服务端重跑一遍解析与回证再落。前端篡改也绕不过回证。
 */
export function LlmDiffDialog({ repoId, pending, previous, onResolved, onOpenChange }: {
  repoId: number;
  pending: { raw: string; engine: string; model: string; profiles: RecommendedProfile[] } | null;
  previous: RecommendedProfile[];
  /** 覆盖成功后把新结果交回面板 */
  onResolved: (profiles: RecommendedProfile[]) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("pages.repos");
  const [busy, setBusy] = useState(false);

  async function overwrite(): Promise<void> {
    if (pending === null || busy) return;
    setBusy(true);
    const res = await apiFetch(`/api/v1/repos/${repoId}/readme/llm/save`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ raw: pending.raw, engine: pending.engine, model: pending.model }),
    }).catch(() => null);
    setBusy(false);

    if (res === null || !res.ok) return void toast.error(t("llmSaveFailed"));
    onResolved(pending.profiles);
    onOpenChange(false);
    toast.success(t("llmSaveDone"));
  }

  return (
    <Dialog open={pending !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("llmDiffTitle")}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <ProfileColumn title={t("llmDiffOld")} profiles={previous} />
          <ProfileColumn title={t("llmDiffNew")} profiles={pending?.profiles ?? []} />
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            {t("llmDiffKeepOld")}
          </Button>
          <Button disabled={busy} onClick={() => void overwrite()}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {t("llmDiffOverwrite")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 一列摘要：每套推荐一行标题 + 字段键值，够用来做取舍判断，不必渲染整张卡 */
function ProfileColumn({ title, profiles }: { title: string; profiles: RecommendedProfile[] }) {
  const t = useTranslations("pages.repos");
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {profiles.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("llmDiffEmpty")}</p>
      ) : (
        profiles.map((profile) => (
          <div key={profile.id} className="rounded-md border p-2">
            <p className="text-xs font-medium">{profile.label === "" ? t("recommendUnnamed") : profile.label}</p>
            <ul className="mt-1 space-y-0.5">
              {Object.entries(profile.server).map(([field, value]) => (
                <li key={field} className="font-mono text-[11px] text-muted-foreground">
                  {field} {String(value)}
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </div>
  );
}
```

- [ ] **步骤 2：接进面板**

`llm-extract-panel.tsx` 的返回值末尾挂上：

```tsx
      <LlmDiffDialog
        repoId={repoId}
        pending={pendingOverwrite}
        previous={profiles}
        onResolved={setProfiles}
        onOpenChange={(open) => { if (!open) setPendingOverwrite(null); }}
      />
```

注意它要挂在**每一个**返回分支之外——最简单的做法是把四态渲染的结果收进一个变量，
在唯一的 return 里连同弹层一起吐出去，避免「不可用」分支早返回时弹层跟着消失。

- [ ] **步骤 3：验证**

```bash
pnpm run lint && npx tsc --noEmit && pnpm run build
```

- [ ] **步骤 4：Commit**

```bash
git add src/components/models/llm-diff-dialog.tsx src/components/models/llm-extract-panel.tsx
```

```bash
git commit -m "feat(readme-llm): 重跑结果的覆盖对比弹层"
```

---

### 任务 17：设置页 LLM 卡

第 9 张卡，形态照 `settings/hf-card.tsx`（那张卡有现成的「只回尾 4 位 + 更换 + 清除 + 测试连接」）。

```
解析引擎   ○ 不用（只用规则）    ○ 本地模型    ○ 外部 API
──────────────────────────────────────────────────────
外部 API：Base URL  [https://api.example.com/v1        ]
          API Key   [已保存 ····a3f9]  [更换]  [清除]
          模型      [GLM-4.7-Flash                     ]
          ▸ 高级：额外请求体
                                              [测试连接]
本地模型：使用当前运行中的模型
          ⚠ 当前没有模型在运行 —— 启动任一模型后可用
```

**文件：**
- 创建：`src/components/settings/llm-card.tsx`
- 修改：`src/app/(panel)/settings/page.tsx`

- [ ] **步骤 1：写卡片**

要点，逐条对照 `hf-card.tsx` 的现成写法：

- 引擎三选一用 `@/components/ui/select` 或一组 radio 形态的按钮，与该文件里其他
  选择器保持一致
- **env 来源的字段禁用输入并标注来源**：`baseUrlSource === "env"` 时输入框
  `disabled` 并在旁边显示 `t("llmFromEnv")`。这是部署方的决定，面板改不动
- API Key 已保存时显示 `····{keyTail}` 与「更换 / 清除」两个按钮，点「更换」才
  换成可输入状态——与 HF Token 完全一致
- 「额外请求体」放在一个 `<details>` 里，`<textarea>` + 一行 hint 举
  `{"thinking":{"type":"disabled"}}` 的例子并说明它是干什么的（关掉推理模型的
  思考，实测差 86 倍 token）。失焦时做一次 `JSON.parse` 校验，非法就红框 + 提示，
  **但不阻止保存**——服务端也会校验，这里只是早一点告诉用户
- 「测试连接」打 `POST /api/v1/settings/llm/test`，成功显示模型名，失败按
  `kind` 显示对应文案（复用 `llmError.*` 那组键）
- 引擎选「本地模型」时，若当前没有模型在运行，显示那行 ⚠ 提示

- [ ] **步骤 2：挂进设置页**

`src/app/(panel)/settings/page.tsx`：照现有 8 张卡的挂法加第 9 张。放在哪个 tab
分组下取决于该文件现有的分组结构（`resolveSettingsTab` 认识的那几个），
**放「运行时」组**——它与模型解析相关，不属于「资料库」。

- [ ] **步骤 3：验证**

```bash
pnpm run lint && npx tsc --noEmit && pnpm run build
```

- [ ] **步骤 4：Commit**

```bash
git add src/components/settings/llm-card.tsx "src/app/(panel)/settings/page.tsx"
```

```bash
git commit -m "feat(readme-llm): 设置页 LLM 解析引擎卡"
```

---

### 任务 18：文案、文档回写与全量验证

- [ ] **步骤 1：补齐两侧文案**

`src/i18n/messages/zh.json` 的 `pages.repos` 下新增（`en.json` 同键，键集合必须完全一致）：

```json
"recommendCardTitle": "推荐模型配置",
"recommendTabRules": "README解析",
"recommendTabLlm": "AI解析",
"recommendTryLlm": "不满意？用 LLM 解析",
"recommendSourceLlm": "AI 解析",
"recommendHitSource": "原文",
"llmIntro": "用 AI 把 README 里散文写的参数抠出来。只抠原文里写过的数值，抠不出的一律丢弃。约 10-30 秒。",
"llmStart": "开始解析",
"llmRerun": "重新解析",
"llmCancel": "取消",
"llmWaiting": "正在等待模型响应…",
"llmFoundNothing": "AI 也没在这份 README 里找到推荐参数",
"llmDropped": "AI 给了 {offered} 个值，{dropped} 个无法在原文中回证，已丢弃",
"llmStale": "README 已更新，这份 AI 结果基于旧版本",
"llmDisabled": "AI 解析未启用",
"llmIncomplete": "外部 API 还没配置完整，缺少 {fields}",
"llmNoRunningModel": "当前没有模型在运行，启动任一模型后可用",
"llmGoSettings": "去设置",
"llmGoModels": "去模型列表",
"llmField": { "baseUrl": "Base URL", "apiKey": "API Key", "model": "模型" },
"llmError": {
  "notConfigured": "AI 解析还没配置好",
  "noRunningModel": "当前没有模型在运行",
  "unauthorized": "API Key 无效或没有权限",
  "rateLimited": "服务商限流，稍后重试",
  "network": "请求失败，检查网络或代理设置",
  "badResponse": "模型输出无法解析，换一个大一点的模型试试"
},
"llmDiffTitle": "覆盖上一次的 AI 解析结果？",
"llmDiffOld": "上一次",
"llmDiffNew": "本次",
"llmDiffEmpty": "没有结果",
"llmDiffKeepOld": "保留旧的",
"llmDiffOverwrite": "覆盖",
"llmSaveDone": "已覆盖",
"llmSaveFailed": "保存失败"
```

英文侧同键。**`badResponse` 与 `llmFoundNothing` 的措辞必须分得开**：前者是
「模型干不了这活」，后者是「跑通了、原文里确实没有」。混为一谈会让用户
以为这个仓库没参数，或者跑去反复重试烧额度。

设置页那组文案放 `pages.settings` 下，键名前缀 `llm`。

- [ ] **步骤 2：跑对称性检查**

```bash
pnpm vitest run src/i18n
```

预期：中英键集合完全一致。

- [ ] **步骤 3：回写设计文档**

`docs/_internal/features/2026-09-02-HF-README与推荐参数-design.md`：

- §9 的「批 3 接口预留（本期不实现）」标题改为「批 3（已实施，详见
  `docs/superpowers/specs/2026-09-03-README-LLM解析-design.md`）」
- §9.4「AI 卡与规则卡混排」那句加一条说明：**实施时改为 tab 分离**（D9），
  理由是规则零成本、AI 要花代价，混排会模糊这个区别
- §14.6「已知未做」里删掉「批 3（LLM 抽取引擎）按 §9 只留接口不实现」
- §9 的 `ExtractEngine` 草稿含 `rules`，实施时去掉了——补一句为什么

`CLAUDE.local.md`：更新测试基线数字，并把批 3 从待办移到已完成。

- [ ] **步骤 4：全量验证**

```bash
pnpm run lint && npx tsc --noEmit && pnpm test && pnpm run build
```

四条全过才算完。测试数应比开工前多 **90 条以上**（10 个新测试文件）。

- [ ] **步骤 5：Commit**

```bash
git add src/i18n/messages/zh.json src/i18n/messages/en.json docs CLAUDE.local.md
```

```bash
git commit -m "docs(readme-llm): 中英文案、设计文档回写与基线更新"
```

---

## 真机验收清单

代码全绿不等于能用。这一批有三处**只能在真机上验**的东西：

- [ ] **1. 同步 key 到真机**：用户的 key 目前填在仓库 `deploy/.env`，真机
      `/mnt/data/apps/llamapad/.env` 还是空的。把三项（含 `PANEL_LLM_EXTRA_BODY`）
      抄过去，然后在 `/mnt/data/apps/llamapad` 跑 `docker compose up -d` 重建容器——
      **改 .env 不重建不生效**。

- [ ] **2. 外部引擎**：拿 `deepseek-ai/DeepSeek-R1` 这类整篇散文、规则 0 套的仓库跑。
      预期：卡头只有 `[AI解析]`、没有 README解析 tab、右上角没有入口链接；点「开始解析」
      能看到流式文本；抠出 `temp=0.6`；展开「原文」显示的正是
      `"Set the temperature within the range of 0.5-0.7 (0.6 is recommended)"` 那句。

- [ ] **3. 限流路径**：免费档实测 5 次里撞 4 次。撞上时必须显示「服务商限流，稍后重试」
      而不是笼统的「请求失败」，且重试按钮还在。

- [ ] **4. 本地引擎**：起一个模型，把引擎切到「本地模型」再跑一次。
      **这是 `response_format: json_object` 在 llama-server 上唯一的验证机会**——
      单测里那是个桩。生效与否只能从返回内容判断，不能从状态码判断。
      顺便验证：没有模型在运行时那行 ⚠ 提示确实出现、按钮确实不给点。

- [ ] **5. 覆盖对比**：在已有结果的仓库上点「重新解析」，确认弹层出现、
      「保留旧的」之后库里还是旧结果、「覆盖」之后是新的。

- [ ] **6. 没有自动请求**：进页面、切 tab、点 README 刷新，观察容器日志/额度，
      确认**一次 LLM 请求都没发**。这条是 §8.4 的硬约束，值得专门验一次。
