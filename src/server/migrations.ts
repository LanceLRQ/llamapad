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
];
