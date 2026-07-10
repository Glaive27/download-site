# 文件下载中心部署指南

## 重要安全提示

在将网站公开到互联网前，请务必修改默认管理员密码和 JWT 密钥：

```bash
# 编辑 .env 文件
SECRET_KEY=你的随机长字符串（至少 32 位）
ADMIN_PASSWORD=你的强密码
```

`.env` 文件包含敏感信息，不要提交到 GitHub 等公共代码仓库。

## 方案一：本地内网穿透（临时演示）

适合临时分享给朋友查看，关闭终端后链接失效。

### 1. 安装依赖并启动后端

```bash
cd /Users/glaive/Desktop/download-site
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# 编辑 .env 设置 SECRET_KEY、ADMIN_PASSWORD、R2_* 等
python main.py
```

服务将运行在 `http://localhost:1234`。

> 本地未配置 R2 时，上传/下载接口会返回 503；登录、注册、创建系列等功能仍可正常测试。

### 2. 启动 localtunnel 穿透

在另一个终端运行：

```bash
npx localtunnel --port 1234
```

首次运行会自动下载 `localtunnel`。启动成功后会输出一个公网 URL，例如：

```text
your url is: https://sour-doors-wait.loca.lt
```

将该 URL 发送给别人即可访问。

### 3. 注意事项

- localtunnel 是临时链接，每次启动 URL 都会变化。
- 部分网络环境下访问时可能需要输入本机公网 IP 的后几位作为验证。
- 电脑关机或关闭终端后，链接立即失效。

## 方案二：部署到 Render（长期免费）

### 1. 准备代码仓库

将项目推送到 GitHub 或 GitLab 仓库（确保 `.env` 已加入 `.gitignore`，不要上传）。

### 2. 一键部署（推荐）

项目已包含 `render.yaml`，支持 Render Blueprint 一键部署：

1. 访问 [Render](https://render.com/) 并注册/登录。
2. 点击 **New +** → **Blueprint**。
3. 选择你的 GitHub/GitLab 仓库。
4. Render 会自动读取 `render.yaml`，创建 Web Service 和 Managed PostgreSQL。
5. 部署完成后，进入 Web Service 的 **Environment** 页面，填写 Cloudflare R2 相关变量：
   - `R2_ACCOUNT_ID`
   - `R2_ACCESS_KEY_ID`
   - `R2_SECRET_ACCESS_KEY`
   - `R2_BUCKET`
   - `R2_PUBLIC_URL`（可选）
6. 修改 `ADMIN_PASSWORD` 为你自己的强密码。
7. 保存后 Render 会自动重新部署。

### 3. 手动创建 Render Web Service

如果不用 Blueprint：

1. 访问 [Render](https://render.com/) 并注册/登录。
2. 先创建 **PostgreSQL** 服务，记录其 `DATABASE_URL`。
3. 点击 **New +** → **Web Service**。
4. 选择你的 GitHub/GitLab 仓库。
5. 填写配置：
   - **Name**: `download-site`
   - **Runtime**: `Python 3`
   - **Build Command**: `pip install --upgrade pip && pip install -r requirements.txt`
   - **Start Command**: `uvicorn main:app --host 0.0.0.0 --port $PORT`
6. 在 **Environment** 中添加以下变量：
   - `SECRET_KEY`：随机长字符串
   - `ADMIN_USERNAME`：Glaive
   - `ADMIN_PASSWORD`：你的强密码
   - `DATABASE_URL`：Render PostgreSQL 的连接字符串
   - `R2_ACCOUNT_ID`、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`、`R2_BUCKET`：Cloudflare R2 配置
   - `R2_PUBLIC_URL`：（可选）R2 公开访问域名
7. 点击 **Create Web Service**。

Render 会自动构建并部署，部署完成后会提供一个永久公网 URL。

### 4. 免费套餐限制

- 免费 Web Service 在 15 分钟无访问后会进入休眠，首次访问需要等待唤醒（约 30 秒）。
- 数据库使用 Render Managed PostgreSQL，上传文件使用 Cloudflare R2，**服务重新部署后数据和文件均不会丢失**。

## 方案三：部署到 Railway

Railway 也提供托管 PostgreSQL 和对象存储集成，部署步骤与 Render 类似：

1. 访问 [Railway](https://railway.app/)。
2. 新建 Project，选择 Deploy from GitHub repo。
3. 添加 PostgreSQL 服务，获取 `DATABASE_URL`。
4. 添加环境变量 `SECRET_KEY`、`ADMIN_USERNAME`、`ADMIN_PASSWORD`、`DATABASE_URL` 以及 R2 相关变量。
5. Railway 会自动检测 Python 项目并部署。

## 方案四：拥有自己的服务器或 VPS

如果你有云服务器（如阿里云、腾讯云、AWS、Vultr 等）：

```bash
# 上传项目到服务器后
sudo apt update
sudo apt install python3-pip
pip3 install -r requirements.txt

# 编辑 .env 设置密码、密钥、PostgreSQL URL、R2 配置
nano .env

# 使用 systemd 或 screen/tmux 后台运行
python3 main.py
```

然后配置 Nginx 反向代理到 `0.0.0.0:1234`，并申请 SSL 证书（Let's Encrypt）。

## 推荐

- **临时分享**：localtunnel
- **长期免费**：Render（Blueprint 一键部署）
- **正式生产**：自有 VPS + Nginx + SSL + PostgreSQL + R2
