-- 数据库迁移脚本：为 file_records 表新增 original_filename 列
--
-- 适用场景：已有数据库（本地 SQLite 或 Render PostgreSQL）中 file_records 表已存在，
--          Base.metadata.create_all 不会自动添加新列，需手动执行此脚本。
--
-- 功能说明：
--   新增 original_filename 列，用于保存用户上传时的原始文件名。
--   这样前端可以显示用户友好的文件名（如"实例.zip"、"123.zip"），
--   而不是系统生成的版本号格式（如"v1.js"、"v2.zip"）。

-- PostgreSQL（Render）执行方式：
--   在 Render Dashboard → 你的 PostgreSQL 实例 → 从本地用 psql 连接外部地址后执行。
--   注意：Dashboard 内复制的 host 是内部地址（如 dpg-xxx-a），本地连接需补全为
--         dpg-xxx-a.<region>-postgres.render.com（默认区域 Oregon）。

-- 本地 SQLite 执行方式（二选一）：
--   方式一（推荐，开发环境）：直接删除 db/users.db 让应用重建表
--       rm db/users.db
--   方式二：用 sqlite3 命令添加列
--       sqlite3 db/users.db "ALTER TABLE file_records ADD COLUMN original_filename VARCHAR(255);"

-- PostgreSQL 专用语句
ALTER TABLE file_records ADD COLUMN IF NOT EXISTS original_filename VARCHAR(255);
