-- 数据库迁移脚本：为 file_records 表新增 file_data 和 file_mime 列
--
-- 适用场景：已有数据库（本地 SQLite 或 Render PostgreSQL）中 file_records 表已存在，
--          Base.metadata.create_all 不会自动添加新列，需手动执行此脚本。
--
-- PostgreSQL（Render）执行方式：
--   在 Render Dashboard → 你的 PostgreSQL 实例 → Command Shell 中粘贴执行以下语句。
--
-- 本地 SQLite 执行方式（二选一）：
--   方式一（推荐，开发环境）：直接删除 db/users.db 让应用重建表
--       rm db/users.db
--   方式二：用 sqlite3 命令添加列
--       sqlite3 db/users.db "ALTER TABLE file_records ADD COLUMN file_data BLOB;"
--       sqlite3 db/users.db "ALTER TABLE file_records ADD COLUMN file_mime VARCHAR(100);"

-- PostgreSQL 专用语句（同时移除 object_key 的唯一约束，因为现在填充占位符 "legacy"）
ALTER TABLE file_records ADD COLUMN IF NOT EXISTS file_data BYTEA;
ALTER TABLE file_records ADD COLUMN IF NOT EXISTS file_mime VARCHAR(100);
ALTER TABLE file_records DROP CONSTRAINT IF EXISTS file_records_object_key_key;
