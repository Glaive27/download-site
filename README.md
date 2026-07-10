# 文件下载中心

基于 **FastAPI** 的文件下载中心，支持用户注册 / 登录、按系列分组的文件上传、版本管理、任意扩展名下载。

## 功能特性

- 用户注册 / 登录（JWT）
- 管理员可创建系列、上传任意扩展名文件、自动版本号（`v1`, `v2`...）
- 普通用户可按系列浏览与下载文件
- 静态文件安全校验（防路径遍历、可执行扩展名黑名单）

## 本地运行

```bash
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# 编辑 .env，设置 SECRET_KEY、ADMIN_PASSWORD
python main.py
# 访问 http://localhost:1234
```

## 部署到 Render

详见 [`docs/deployment.md`](docs/deployment.md)。项目已包含：

- `Procfile` — 启动命令
- `render.yaml` — 基础设施即代码，一键创建 Web Service
- `runtime.txt` — 锁定 Python 版本
- `requirements.txt` — 依赖列表

### 推荐的 Render 配置

| 配置项 | 值 |
| --- | --- |
| Runtime | Python |
| Build Command | `pip install --upgrade pip && pip install -r requirements.txt` |
| Start Command | `uvicorn main:app --host 0.0.0.0 --port $PORT` |

### 必须的环境变量

| 变量 | 说明 |
| --- | --- |
| `SECRET_KEY` | JWT 签名密钥（Render 可自动生成） |
| `ADMIN_USERNAME` | 管理员账号 |
| `ADMIN_PASSWORD` | 管理员密码（**未设置时默认 `19866179818`，生产请修改**） |
| `DATA_DIR` | 数据存储目录，建议设为 `/tmp/data`（Render 免费版磁盘为临时存储） |
| `RESET_ADMIN_PASSWORD` | `1` 时启动时强制重置管理员密码为 `ADMIN_PASSWORD` 当前值 |
| `ADMIN_INIT_TOKEN` | 启用 `POST /api/admin/reset-password` 紧急重置端点（密码丢失时用） |

### 排查：管理员登录失败

部署后访问 `https://<你的-render-域名>/api/admin/diag`，返回 JSON 显示：
- `db_exists`: SQLite 文件是否创建
- `admin_exists`: 管理员账号是否存在
- `secret_key_configured`: `SECRET_KEY` 是否已设置
- `reset_endpoint_available`: 密码重置端点是否可用

如果忘记管理员密码（且已设置 `ADMIN_INIT_TOKEN`）：

```bash
curl -X POST "https://<你的-render-域名>/api/admin/reset-password?token=$ADMIN_INIT_TOKEN&new_password=$NEW_PW"
```

或者更简单：在 Render 控制台 Environment 把 `RESET_ADMIN_PASSWORD` 改为 `1`（同时设置新的 `ADMIN_PASSWORD`），保存后 Render 自动重新部署，密码就被重置。改完后再把 `RESET_ADMIN_PASSWORD` 改回 `0`。

## ⚠️ Render 免费版注意事项

- **SQLite 数据**：Render 免费 Web Service 的磁盘为临时存储，**每次重新部署数据会被清空**。需要持久化请升级到付费 PostgreSQL，或自行接入外部数据库。
- **上传文件**：同上，`/tmp` 在重启后会丢失。生产环境建议接入 S3 / Cloudinary 等对象存储。
- **休眠机制**：15 分钟无访问后休眠，首次访问需等待约 30 秒唤醒。

## 项目结构

```
.
├── main.py              # FastAPI 入口
├── init_db.py           # 数据库初始化
├── auth/                # 用户认证模块
│   ├── database.py
│   ├── models.py
│   ├── router.py
│   ├── schemas.py
│   └── security.py
├── static/              # 前端静态资源
├── tests/               # 测试用例
├── files/               # 上传文件目录
├── db/                  # SQLite 数据库目录
├── docs/                # 文档
├── requirements.txt     # 依赖
├── Procfile             # Render / Heroku 启动声明
├── render.yaml          # Render 基础设施即代码
└── runtime.txt          # Python 版本
```
