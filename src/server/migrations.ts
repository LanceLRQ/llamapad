// 迁移脚本数组：索引 i 即版本 i+1；已发布的历史条目绝不修改，只追加。
// 后续里程碑的新表（如 M2 download、M3 metrics）以新元素追加，不做条件分支。
export const MIGRATIONS: string[] = [
  // v1：M0 基础六表
  `
CREATE TABLE namespaces(
  name TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
CREATE TABLE models(
  name TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  namespace TEXT NOT NULL REFERENCES namespaces(name),
  gguf_file TEXT NOT NULL,
  mmproj_file TEXT,
  download TEXT,
  overrides TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE settings(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE admins(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE api_tokens(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL
);
`,
  // v2：M2 下载系统三表（任务明细 / 历史归档 / HF Token）
  `
CREATE TABLE download_tasks(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  repo TEXT, url TEXT,
  file TEXT NOT NULL,
  target_rel TEXT NOT NULL,
  shard_index INTEGER, shard_total INTEGER,
  expected_size INTEGER, sha256 TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  downloaded_bytes INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE download_history(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_name TEXT NOT NULL,
  files TEXT NOT NULL,
  total_bytes INTEGER NOT NULL,
  status TEXT NOT NULL,
  finished_at INTEGER NOT NULL);
CREATE TABLE hf_token(
  token TEXT PRIMARY KEY,
  note TEXT,
  created_at INTEGER NOT NULL);
`,
  // v3：M3 指标聚合桶（1min 与 15min 共表，granularity 区分：1=分钟桶，15=15分钟桶；
  // bucket_start 为秒级窗口整点；PK 保证同一指标同一窗口只有一行，配合 INSERT OR REPLACE 幂等）
  `
CREATE TABLE metrics_bucket(
  metric_id TEXT NOT NULL,
  granularity INTEGER NOT NULL,
  bucket_start INTEGER NOT NULL,
  min REAL NOT NULL,
  max REAL NOT NULL,
  avg REAL NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY(metric_id, granularity, bucket_start));
`,
  // v4：M5 api_tokens 补 token_tail（明文尾 4 位，供列表对照；旧行为 NULL——
  // 库里只存 sha256，明文尾号无从逆推，属不可补的历史数据，列表以 "" 兜底）
  `
ALTER TABLE api_tokens ADD COLUMN token_tail TEXT;
`,
  // v5：UX P1 U15 下载完成自动启动——入队时按模型组打在任务行上的意图标记
  // （组内行同值；完成钩子读窗口内行的标记决定是否触发启动）
  `
ALTER TABLE download_tasks ADD COLUMN auto_start INTEGER NOT NULL DEFAULT 0;
`,
  // v6：UX P1 U16 后半——GGUF 元数据缓存。命中条件 = path + size + mtime 三者一致
  // （文件内容变了 mtime 必变），避免每次进编辑页都重新扫描一遍 KV 段。
  `
CREATE TABLE gguf_meta(
  path TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  arch TEXT,
  block_count INTEGER,
  context_length INTEGER,
  file_type INTEGER,
  parsed_at INTEGER NOT NULL
);
`,
  // v7：UX P1 U17 运行历史 + 显存 preflight——按次记录模型运行的起止时间、
  // tok/s 与显存峰值。峰值显存存净增量的两个原始读数（peak/baseline 分开存
  // 而非直接存差值）：整卡显存会被同机其它进程（如 comfyui）占用抬高，
  // 存原始值保留日后改口径重算的余地。ended_at IS NULL 表示运行中，
  // 单模型约束下同一时刻至多一行。
  `
CREATE TABLE runs(
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  model                TEXT NOT NULL,
  started_at           INTEGER NOT NULL,
  ended_at             INTEGER,
  end_reason           TEXT,
  avg_tokens_per_sec   REAL,
  peak_tokens_per_sec  REAL,
  peak_gpu_mem_mib     REAL,
  baseline_gpu_mem_mib REAL,
  gpu_mem_total_mib    REAL
);
CREATE INDEX idx_runs_model ON runs(model, started_at DESC);
`,
  // v8：文件元信息（设计 §3.2，docs/_internal/features/2026-08-28-文件管理与镜像管理-design.md）。
  // 一行 = 一个逻辑条目而非物理文件：单文件 path 为相对路径，分片组 path 为 glob
  // （与 gguf_file 存的形态字面一致）。主键用自增 id、path 仅唯一索引——path 与
  // 两份 sha256 都是可变属性而非身份，运维手动 mv/卷迁移导致的路径变化不应让
  // 记录彻底失联（与 gguf_meta 纯缓存的语义不同，此表存的是用户手填数据）。
  `
CREATE TABLE file_meta(
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  path          TEXT NOT NULL UNIQUE,
  is_group      INTEGER NOT NULL DEFAULT 0,
  probe_path    TEXT NOT NULL,
  size          INTEGER,
  mtime         INTEGER,
  sample_sha256 TEXT,
  full_sha256   TEXT,
  quant_label   TEXT,
  mark          TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_file_meta_sample ON file_meta(sample_sha256);
CREATE INDEX idx_file_meta_full   ON file_meta(full_sha256);
`,
  // v9：仓库档案（设计 §4.1，docs/_internal/features/2026-08-30-仓库档案与下载解耦-design.md）。
  // 一行 = 一个 HF 仓库在某个 base 目录下的落地，落盘目录恒为 base_dir/repo，
  // 目录内另有 .llamapad-repo 标记文件作为第二真源（整目录被手动搬走后仍可认领）。
  // 不设 source 列：URL 直链不建档案，档案恒为 HF；不设 display_name：直接显示 repo。
  // UNIQUE(base_dir, repo) 允许同一仓库在不同 base 各有一份，新建时由 probe 提示复用。
  `
CREATE TABLE model_repos(
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  repo       TEXT NOT NULL,
  base_dir   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(base_dir, repo)
);
ALTER TABLE download_tasks ADD COLUMN repo_id INTEGER;
`,
];
