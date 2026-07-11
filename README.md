# 文件下载中心

基于 **FastAPI** 的文件下载中心，支持用户注册 / 登录、按系列分组的文件上传、版本管理、任意扩展名下载。

## 功能特性

- 用户注册 / 登录（JWT）
- 登录 / 注册需通过 **ALTCHA 人机验证**（Proof-of-Work CAPTCHA，自托管、对服务器近乎零负担）
- 管理员可创建系列、上传任意扩展名文件、自动版本号（`v1`, `v2`...）
- 普通用户可按系列浏览与下载文件
- 文件持久化存储在 **Cloudflare R2（S3 API）**，服务重启/休眠不丢失
- 数据库使用 **Render PostgreSQL**，本地开发自动回退到 SQLite

## 本地运行

```bash
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# 编辑 .env，设置 SECRET_KEY、ADMIN_PASSWORD、R2_* 等
python main.py
# 访问 http://localhost:1234
```

> 本地未配置 R2 时，上传/下载接口会返回 503；登录、注册、创建系列等功能仍可正常测试。

## 部署到 Render

项目已包含 `render.yaml`，在 Render Dashboard 选择 **New + > Blueprint** 并导入本仓库，即可一键创建：

- Web Service（Python）
- Managed PostgreSQL（Render PostgreSQL）
- 自动生成 `SECRET_KEY`、`ADMIN_PASSWORD`、`ADMIN_INIT_TOKEN`

### 一键部署后必须做的事

1. 在 Render 控制台进入 Web Service 的 **Environment** 页面。
2. 填写 Cloudflare R2 相关环境变量（真实值）：
   - `R2_ACCOUNT_ID`
   - `R2_ACCESS_KEY_ID`
   - `R2_SECRET_ACCESS_KEY`
   - `R2_BUCKET`
3. （可选）如果 R2 桶已开启公开访问并绑定了自定义域名，填写 `R2_PUBLIC_URL`。
4. 修改 `ADMIN_PASSWORD` 为你自己的强密码（默认由 Render 自动生成）。
5. 保存后 Render 会自动重新部署。

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
| `ADMIN_PASSWORD` | 管理员密码（**首次部署后请修改为强密码**） |
| `DATABASE_URL` | Render PostgreSQL 连接字符串（由 `render.yaml` 自动注入） |
| `R2_ACCOUNT_ID` | Cloudflare R2 账户 ID |
| `R2_ACCESS_KEY_ID` | R2 API 访问密钥 ID |
| `R2_SECRET_ACCESS_KEY` | R2 API 秘密访问密钥 |
| `R2_BUCKET` | R2 桶名称 |
| `R2_PUBLIC_URL` | （可选）R2 公开访问域名，配置后使用直链而非预签名链接 |
| `RESET_ADMIN_PASSWORD` | `1` 时启动时强制重置管理员密码为 `ADMIN_PASSWORD` 当前值 |
| `ADMIN_INIT_TOKEN` | 启用 `POST /api/admin/reset-password` 紧急重置端点（密码丢失时用） |
| `ALTCHA_HMAC_KEY` | ALTCHA 人机验证 HMAC 密钥（Render 可自动生成），用于签发挑战与校验凭证 |

### 排查：管理员登录失败

部署后访问 `https://<你的-render-域名>/api/admin/diag`，返回 JSON 显示：
- `database_url_configured`: `DATABASE_URL` 是否已设置
- `r2_configured`: R2 是否已配置
- `admin_exists`: 管理员账号是否存在
- `secret_key_configured`: `SECRET_KEY` 是否已设置
- `reset_endpoint_available`: 密码重置端点是否可用

如果忘记管理员密码（且已设置 `ADMIN_INIT_TOKEN`）：

```bash
curl -X POST "https://<你的-render-域名>/api/admin/reset-password?token=$ADMIN_INIT_TOKEN&new_password=$NEW_PW"
```

或者更简单：在 Render 控制台 Environment 把 `RESET_ADMIN_PASSWORD` 改为 `1`（同时设置新的 `ADMIN_PASSWORD`），保存后 Render 自动重新部署，密码就被重置。改完后再把 `RESET_ADMIN_PASSWORD` 改回 `0`。

## Cloudflare R2 配置指南

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)，进入 R2。
2. 创建一个桶（Bucket），建议桶名与项目相关，例如 `download-site-files`。
3. 进入桶的 **Settings**，如果希望使用直链下载，可开启公开访问并绑定自定义域名，将域名填入 `R2_PUBLIC_URL`。
4. 进入 **Manage R2 API Tokens**，创建 API 令牌，权限至少包含 **Object Read & Write**。
5. 记录：
   - **Account ID** → `R2_ACCOUNT_ID`
   - **Access Key ID** → `R2_ACCESS_KEY_ID`
   - **Secret Access Key** → `R2_SECRET_ACCESS_KEY`
   - **Bucket Name** → `R2_BUCKET`

## 数据持久化说明

- **数据库**：Render PostgreSQL 为托管服务，服务重启、重新部署后数据永久保留。本地开发使用 SQLite。
- **上传文件**：所有文件存储在 Cloudflare R2 对象存储，不再保存到本地 `files/` 或 `/tmp`，因此 Render 免费版休眠、重启、重新部署后文件都不会丢失。

## 项目结构

```
.
├── main.py              # FastAPI 入口
├── init_db.py           # 数据库初始化
├── storage.py           # Cloudflare R2（S3 API）封装
├── auth/                # 用户认证模块
│   ├── database.py
│   ├── models.py
│   ├── router.py
│   ├── schemas.py
│   ├── security.py
│   └── altcha.py          # ALTCHA 人机验证（PoW CAPTCHA）校验
├── static/              # 前端静态资源
├── tests/               # 测试用例
├── docs/                # 文档
├── requirements.txt     # 依赖
├── Procfile             # Render / Heroku 启动声明
├── render.yaml          # Render 基础设施即代码
└── runtime.txt          # Python 版本
```
