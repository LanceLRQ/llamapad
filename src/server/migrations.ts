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
];
