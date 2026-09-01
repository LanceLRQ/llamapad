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
  // v10：下载表重建（设计 §4.3）。model_name 这个分组键换成 batch_id + repo_id：
  // 「一批下载」才是归档与展示的单元，而模型配置在下载时可能压根还不存在。
  // 用户已授权清空历史数据（D22），故直接 DROP + CREATE 不搬数据 —— 面板本来
  // 就有「清除历史」按钮做同样的事，这里不引入新的破坏性语义。
  // auto_start 列随重建消失：下载完只有文件、还没有配置，无从启动（D5）。
  `
DROP TABLE download_tasks;
CREATE TABLE download_tasks(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL,
  repo_id INTEGER REFERENCES model_repos(id),
  label TEXT NOT NULL,
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
CREATE INDEX idx_download_tasks_batch ON download_tasks(batch_id);

DROP TABLE download_history;
CREATE TABLE download_history(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL,
  repo_id INTEGER REFERENCES model_repos(id),
  label TEXT NOT NULL,
  files TEXT NOT NULL,
  total_bytes INTEGER NOT NULL,
  status TEXT NOT NULL,
  finished_at INTEGER NOT NULL);
`,
  // v11：两张下载表的 repo_id 补 ON DELETE SET NULL（任务 C1）。v10 建表时漏了
  // 这条子句，默认 NO ACTION：档案一旦被下载过（done 任务行、每批必落的
  // download_history）就再也删不掉——外键直接拒绝 DELETE FROM model_repos。
  // 选 SET NULL 而非 CASCADE：用户删的是「档案」这个管理关系，下载历史应该
  // 保留，只是不再归属任何档案（repo_id 本来就可空，URL 直链下载从建表起
  // 就一直是 NULL，语义上完全一致）。
  //
  // SQLite 改不了已有列的约束，只能整表重建；用户没有再次授权清空数据
  // （v10 那次 DROP+CREATE 是一次性的），这里必须原样保留全部行——
  // INSERT ... SELECT 逐列显式列名，不用 SELECT *（列顺序巧合对齐是定时炸弹）。
  // DROP TABLE 会连带删掉索引，idx_download_tasks_batch 挪到 RENAME 之后重建。
  // 这两张表纯子表，没有别的表引用它们，重建期间外键始终保持开着是安全的；
  // 又因为整段跑在 runMigrations 的 db.transaction() 里，事务内 PRAGMA
  // foreign_keys 本就静默无效，这里也确实用不上它，不写那句自我安慰。
  `
CREATE TABLE download_tasks_new(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL,
  repo_id INTEGER REFERENCES model_repos(id) ON DELETE SET NULL,
  label TEXT NOT NULL,
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
INSERT INTO download_tasks_new(
  id, batch_id, repo_id, label, kind, source, repo, url, file, target_rel,
  shard_index, shard_total, expected_size, sha256, status, downloaded_bytes,
  error, created_at, updated_at)
SELECT
  id, batch_id, repo_id, label, kind, source, repo, url, file, target_rel,
  shard_index, shard_total, expected_size, sha256, status, downloaded_bytes,
  error, created_at, updated_at
FROM download_tasks;
DROP TABLE download_tasks;
ALTER TABLE download_tasks_new RENAME TO download_tasks;
CREATE INDEX idx_download_tasks_batch ON download_tasks(batch_id);

CREATE TABLE download_history_new(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL,
  repo_id INTEGER REFERENCES model_repos(id) ON DELETE SET NULL,
  label TEXT NOT NULL,
  files TEXT NOT NULL,
  total_bytes INTEGER NOT NULL,
  status TEXT NOT NULL,
  finished_at INTEGER NOT NULL);
INSERT INTO download_history_new(
  id, batch_id, repo_id, label, files, total_bytes, status, finished_at)
SELECT
  id, batch_id, repo_id, label, files, total_bytes, status, finished_at
FROM download_history;
DROP TABLE download_history;
ALTER TABLE download_history_new RENAME TO download_history;
`,
  // v12：gguf_meta 补 chat_template 列（「思考强度」reasoning_effort 判定的唯一数据
  // 来源，见 lib/reasoning-effort.ts）。不用 ALTER TABLE ADD COLUMN：存量行该列会
  // 补成 NULL，而 NULL 在这里天生歧义——分不清是"这个 GGUF 确实没有内嵌模板"还是
  // "旧版本压根没采这一列"，会让老部署升级后已缓存的模型永远判定为 unknown（明明
  // 文件里有模板）。gguf_meta 是纯缓存（v8 file_meta 注释里写明的语义：与它不同，
  // gguf_meta 不存用户手填数据），DROP 重建零风险，代价只是下次访问时重新解析一遍
  // KV 段（parseGguf 本身足够快，见 v6 注释）。
  `
DROP TABLE IF EXISTS gguf_meta;
CREATE TABLE gguf_meta(
  path TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  arch TEXT,
  block_count INTEGER,
  context_length INTEGER,
  file_type INTEGER,
  chat_template TEXT,
  parsed_at INTEGER NOT NULL
);
`,
];
