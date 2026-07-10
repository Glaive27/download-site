# 数据库设计

## 1. 数据库选型

- **线上环境**：PostgreSQL（Render Managed PostgreSQL，通过 `DATABASE_URL` 连接）
- **本地开发**：SQLite（未设置 `DATABASE_URL` 时自动回退到 `db/users.db`）
- **ORM**：SQLAlchemy 2.x

线上使用 PostgreSQL 以保证服务重新部署、休眠唤醒后数据持久化；本地使用 SQLite 以零配置快速启动。

## 2. 数据表结构

### users 表

存储用户认证信息。

| 字段名           | 类型         | 约束                     | 说明                         |
|------------------|--------------|--------------------------|------------------------------|
| id               | INTEGER      | PRIMARY KEY, AUTOINCREMENT | 主键，自增                   |
| username         | VARCHAR(64)  | UNIQUE, NOT NULL, INDEX  | 用户名，全局唯一             |
| hashed_password  | VARCHAR(255) | NOT NULL                 | bcrypt 加密后的密码哈希       |
| role             | VARCHAR(16)  | NOT NULL, DEFAULT 'user' | 角色：`user` 或 `admin`      |

### series 表

存储已创建的文件系列名，保证系列元数据持久化。

| 字段名     | 类型          | 约束                    | 说明             |
|------------|---------------|-------------------------|------------------|
| id         | INTEGER       | PRIMARY KEY, AUTOINCREMENT | 主键，自增       |
| name       | VARCHAR(128)  | UNIQUE, NOT NULL, INDEX | 系列名，全局唯一 |
| created_at | DATETIME      | NOT NULL                | 创建时间         |

### file_records 表

存储文件元数据，实际文件内容保存在 Cloudflare R2（S3 API）。

| 字段名     | 类型          | 约束                    | 说明                            |
|------------|---------------|-------------------------|---------------------------------|
| id         | INTEGER       | PRIMARY KEY, AUTOINCREMENT | 主键，自增                      |
| series     | VARCHAR(128)  | NOT NULL, INDEX         | 所属系列名                      |
| filename   | VARCHAR(255)  | NOT NULL, INDEX         | 下载显示文件名，如 `docs_v1.pdf` |
| version    | VARCHAR(32)   | NOT NULL                | 版本号，如 `v1`、`v2`           |
| size       | INTEGER       | NOT NULL                | 文件大小（字节）                |
| mime_type  | VARCHAR(128)  | NOT NULL                | 文件 MIME 类型                  |
| object_key | VARCHAR(512)  | UNIQUE, NOT NULL, INDEX | R2 对象键，如 `docs/docs_v1.pdf` |
| created_at | DATETIME      | NOT NULL                | 上传时间                        |

## 3. 安全设计

- **密码加密**：使用 `bcrypt` 算法通过 `passlib` 进行单向哈希，数据库中不存储任何明文密码。
- **SQL 注入防护**：所有数据库操作均通过 SQLAlchemy ORM 参数化查询完成，不拼接 SQL 字符串。
- **角色字段**：通过 `role` 字段区分普通用户（`user`）与管理员（`admin`），后端接口使用 `require_admin` 依赖进行权限校验。
- **文件持久化**：上传文件不再保存到本地磁盘，而是上传到 Cloudflare R2，数据库仅保存元数据和 R2 对象键。

## 4. 初始化脚本

启动应用时会自动执行 `init_db.py`：

1. 创建所有数据表（若不存在）。
2. 检查预设管理员账号是否存在。
3. 若不存在，使用 `bcrypt` 对初始密码进行哈希后写入数据库。

默认管理员信息：

- 用户名：`Glaive`
- 密码：环境变量 `ADMIN_PASSWORD` 的值（未设置时默认 `19866179818`）
- 角色：`admin`

如需手动初始化，可运行：

```bash
python init_db.py
```
