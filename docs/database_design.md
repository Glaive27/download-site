# 用户认证系统数据库设计

## 1. 数据库选型

- **数据库**：SQLite
- **ORM**：SQLAlchemy 2.x
- **位置**：`db/users.db`

SQLite 轻量、零配置，适合本项目作为文件下载中心的用户认证后端。

## 2. 数据表结构

### users 表

| 字段名           | 类型         | 约束                     | 说明                         |
|------------------|--------------|--------------------------|------------------------------|
| id               | INTEGER      | PRIMARY KEY, AUTOINCREMENT | 主键，自增                   |
| username         | VARCHAR(64)  | UNIQUE, NOT NULL, INDEX  | 用户名，全局唯一             |
| hashed_password  | VARCHAR(255) | NOT NULL                 | bcrypt 加密后的密码哈希       |
| role             | VARCHAR(16)  | NOT NULL, DEFAULT 'user' | 角色：`user` 或 `admin`      |

## 3. 建表语句

```sql
CREATE TABLE users (
    id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    username VARCHAR(64) NOT NULL,
    hashed_password VARCHAR(255) NOT NULL,
    role VARCHAR(16) NOT NULL DEFAULT 'user',
    UNIQUE (username)
);

CREATE INDEX ix_users_id ON users (id);
CREATE INDEX ix_users_username ON users (username);
```

## 4. 安全设计

- **密码加密**：使用 `bcrypt` 算法通过 `passlib` 进行单向哈希，数据库中不存储任何明文密码。
- **SQL 注入防护**：所有数据库操作均通过 SQLAlchemy ORM 参数化查询完成，不拼接 SQL 字符串。
- **角色字段**：通过 `role` 字段区分普通用户（`user`）与管理员（`admin`），后端接口使用 `require_admin` 依赖进行权限校验。

## 5. 初始化脚本

运行以下命令初始化数据库并创建默认管理员账号：

```bash
python init_db.py
```

默认管理员信息：

- 用户名：`Glaive`
- 密码：`19866179818`
- 角色：`admin`

脚本执行逻辑：

1. 创建 `users` 表（若不存在）。
2. 检查 `Glaive` 是否已存在。
3. 若不存在，使用 `bcrypt` 对初始密码进行哈希后写入数据库。
