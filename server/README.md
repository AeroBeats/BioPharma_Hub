# BioPharma Hub 后端部署指南

用户 / 组织 / 角色 / 库存 的后端服务。前端是 GitHub Pages 上的纯静态站点，
通过 HTTPS 调用本后端。本指南覆盖：本地开发、生产部署（Linux 服务器 +
PostgreSQL + gunicorn + nginx + systemd + Cloudflare 子域名）、ICP 备案分支、
前端对接、日常运维。

> 面向 git / Linux 新手：每一步都给出可直接复制的命令。命令里出现
> `你的xxx` 的地方，替换成你自己的值再回车。

---

## 1. 架构概览

```
浏览器
  │  ① 打开静态站点
  ▼
GitHub Pages  https://aerobeats.github.io/BioPharma_Hub/
  │  ② 登录后所有数据请求（JWT Bearer Token）
  ▼
Cloudflare 子域名  https://hubapi.aerobeats.xyz   （代理 + 免费 SSL）
  │  ③ 反代到本机
  ▼
nginx (443/80) ──► gunicorn (127.0.0.1:8000) ──► Flask app
                                                    │
                                                    ▼
                                              PostgreSQL
```

- **技术栈**：Python 3.11+ / Flask 3 / SQLAlchemy 2 / psycopg3 / PyJWT / bcrypt / gunicorn。
- **数据库**：生产用 PostgreSQL；本地开发可用 SQLite（零配置）。
- **认证**：用户名 + 密码登录，签发 JWT（默认 7 天过期）。密码用 bcrypt 加盐哈希，绝不明文存储。
- **角色**：
  - 超级管理员（全局 `is_super_admin`）：发放组织邀请码、管理所有组织。
  - 组织管理员（`org_admin`）：管理本组织成员、组织码、数据。
  - QA（`qa`）：只读（GLP 职责分离，不能改数据）。
  - 普通成员（`member`）/ SD（`sd`）：可读写本组织数据。
- **GLP 对齐**：服务端 UTC 时间戳、软删除（`deleted_at`）、版本号（`version`）、
  只增不改的审计日志（`AuditLog`）、电子签名表（`Signature`，21 CFR Part 11）。

**注册 / 加入流程**：
1. 超级管理员在「管理后台」生成组织邀请码 `INV-XXXXXXXXXX`。
2. 用户用邀请码「创建组织」→ 邀请码被消费，创建者成为该组织管理员，系统自动生成组织码 `ORG-XXXXXXXXXX`。
3. 其他成员用组织码「加入组织」。

---

## 2. 本地开发（Windows / macOS / Linux，SQLite）

无需 PostgreSQL，用文件数据库即可跑通全部功能。

```bash
# 进入后端目录
cd server

# 创建并激活虚拟环境
python -m venv .venv
# Windows (git-bash):
source .venv/Scripts/activate
# macOS / Linux:
# source .venv/bin/activate

# 安装依赖
pip install -r requirements.txt

# 不配置 .env 时默认用 SQLite（server/dev.db），JWT_SECRET 为开发占位值。
# 创建超级管理员（会安全提示输入密码，不进 shell 历史）：
python init_admin.py --username admin
# 按提示输入两次密码（至少 8 位）。

# 启动开发服务器（http://127.0.0.1:8000）
python app.py
```

另开一个终端跑前端静态服务器（模拟线上 GitHub Pages）：

```bash
# 在仓库根目录
python dev/server.py 8099
# 浏览器打开 http://127.0.0.1:8099
```

前端在 `localhost` / `127.0.0.1` 下会自动把 API 指向 `http://127.0.0.1:8000`，
所以本地登录、组织、库存都能直接联调。

**跑一遍后端自检**（47 项断言，覆盖认证 / 组织 / 角色 / 邀请码 / 库存 / 审计）：

```bash
cd server
source .venv/Scripts/activate   # 或 .venv/bin/activate
python smoke_test.py
```

---

## 3. 生产部署（你的 Linux 服务器）

下面以 Ubuntu / Debian 为例。需要：一台能公网访问的服务器、一个域名
（示例用 `aerobeats.xyz`）、root 或 sudo 权限。

### 3.1 安装基础软件

```bash
sudo apt update
sudo apt install -y python3 python3-venv python3-pip postgresql nginx
```

确认 Python ≥ 3.11：`python3 --version`。

### 3.2 创建 PostgreSQL 数据库和用户

```bash
sudo -u postgres psql
```

进入 `psql` 交互界面后，逐行执行（把 `你的密码` 换成强密码，记下来）：

```sql
CREATE USER biopharma WITH PASSWORD '你的密码';
CREATE DATABASE biopharma_hub OWNER biopharma;
GRANT ALL PRIVILEGES ON DATABASE biopharma_hub TO biopharma;
\q
```

> 表结构不用手写 SQL：应用启动时 `init_db()` 会自动 `create_all`（幂等）。

### 3.3 拉取代码并安装依赖

```bash
# 把仓库放到 /opt（也可放你的 home 目录）
cd /opt
sudo git clone https://github.com/AeroBeats/BioPharma_Hub.git
cd BioPharma_Hub/server

sudo python3 -m venv .venv
sudo .venv/bin/pip install --upgrade pip
sudo .venv/bin/pip install -r requirements.txt
```

### 3.4 配置 `.env`

```bash
cd /opt/BioPharma_Hub/server
sudo cp .env.example .env
sudo nano .env
```

填写以下关键项（其余保持默认即可）：

```ini
# 数据库：二选一。推荐直接写完整 URL。
DATABASE_URL=postgresql+psycopg://biopharma:你的密码@127.0.0.1:5432/biopharma_hub

# 认证密钥：必须是长随机串。在服务器上生成：
#   python3 -c "import secrets;print(secrets.token_urlsafe(48))"
# 把输出粘贴到下面（不要用示例值！）
JWT_SECRET=粘贴上面生成的长随机串
JWT_EXPIRES_DAYS=7

# 允许调用本 API 的前端来源（GitHub Pages 站点）。多个用逗号分隔。
ALLOWED_ORIGINS=https://aerobeats.github.io
```

保存退出（nano：`Ctrl+O` 回车，`Ctrl+X`）。

收紧权限，避免别人读到密钥：

```bash
sudo chmod 600 .env
```

### 3.5 建表 + 创建超级管理员

```bash
cd /opt/BioPharma_Hub/server
sudo .venv/bin/python init_admin.py --username admin
# 按提示输入两次强密码（至少 8 位）。这个账号能发放邀请码、管理所有组织。
```

`init_admin.py` 会先 `init_db()` 建好所有表，再创建（或提升）超级管理员。

> 安全提醒：生产环境务必用强密码；`.env` 里的 `JWT_SECRET` 一旦泄露，
> 别人就能伪造任意用户的登录令牌。

### 3.6 用 gunicorn + systemd 常驻运行

先手动验证 gunicorn 能起来：

```bash
cd /opt/BioPharma_Hub/server
sudo .venv/bin/gunicorn --bind 127.0.0.1:8000 --workers 2 wsgi:app
# 看到 Listening at: http://127.0.0.1:8000 即正常。Ctrl+C 停掉。
```

创建 systemd 服务，让它开机自启、崩溃自动重启：

```bash
sudo nano /etc/systemd/system/biopharma.service
```

粘贴（注意 `User`/`Group` 改成你跑代码的用户；若代码在 `/opt` 且用 root 克隆，
可保持 root，但更推荐建一个专用用户）：

```ini
[Unit]
Description=BioPharma Hub backend (gunicorn)
After=network.target postgresql.service

[Service]
Type=notify
User=root
Group=root
WorkingDirectory=/opt/BioPharma_Hub/server
EnvironmentFile=/opt/BioPharma_Hub/server/.env
ExecStart=/opt/BioPharma_Hub/server/.venv/bin/gunicorn \
    --bind 127.0.0.1:8000 \
    --workers 2 \
    --timeout 60 \
    wsgi:app
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

启用并启动：

```bash
sudo systemctl daemon-reload
sudo systemctl enable biopharma
sudo systemctl start biopharma
sudo systemctl status biopharma     # 应显示 active (running)
```

> gunicorn 的 `Type=notify` 需要较新版本；若启动报错，把 `Type=notify`
> 改成 `Type=simple` 再 `daemon-reload` + `restart`。

### 3.7 nginx 反向代理

```bash
sudo nano /etc/nginx/sites-available/biopharma
```

粘贴（`server_name` 换成你的子域名）：

```nginx
server {
    listen 80;
    server_name hubapi.aerobeats.xyz;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

启用站点：

```bash
sudo ln -s /etc/nginx/sites-available/biopharma /etc/nginx/sites-enabled/
sudo nginx -t          # 测试配置，应显示 syntax ok / test successful
sudo systemctl reload nginx
```

### 3.8 Cloudflare 子域名 + HTTPS

1. 登录 Cloudflare → 选择 `aerobeats.xyz` → **DNS** → **Add record**：
   - Type: `A`，Name: `hubapi`，Content: `你的服务器公网IP`，
   - **Proxy status: Proxied（橙色云朵）**。这样流量走 Cloudflare，自动给免费 SSL，
     并隐藏你的真实服务器 IP。
2. **SSL/TLS** 模式设为 **Full** 或 **Full (strict)**。
   - 用 Cloudflare 源证书（Origin Certificate）放在 nginx 上可用 **Full (strict)**；
   - 若 nginx 只监听 80（HTTP），Cloudflare 到源站这段用 **Full** 即可
     （浏览器到 Cloudflare 仍是 HTTPS）。最稳妥：给 nginx 也配上证书走 443。
3. 等 DNS 生效（通常几分钟），浏览器访问 `https://hubapi.aerobeats.xyz/health`
   应返回 `{"ok":true,"service":"biopharma-hub-backend","db":"postgresql"}`。

> 前端 `web/auth.js` 里的生产地址是 `https://hubapi.aerobeats.xyz`。
> 如果你的子域名不是这个，改 `auth.js` 顶部的 `PROD_API` 常量即可。

### 3.9 防火墙

只开放必要端口（SSH / HTTP / HTTPS）。PostgreSQL 只监听本机，不对外。

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'   # 同时放行 80 和 443
sudo ufw enable
sudo ufw status
```

确认 PostgreSQL 只绑本机：`sudo nano /etc/postgresql/*/main/postgresql.conf`，
`listen_addresses = 'localhost'`（默认即是）。**不要**把 5432 暴露到公网。

---

## 4. 网站要备案吗？（境内 / 境外两种情况）

**取决于你的服务器物理位置，不是域名注册商。**

### 情况 A：服务器在中国大陆（阿里云 / 腾讯云 / 华为云等）

- **必须做 ICP 备案**，否则运营商会拦截 80/443 端口，网站无法公网访问。
- 对 `aerobeats.xyz` 做**非经营性 ICP 备案**：通过你的服务器厂商后台提交
  （ they 代提交到管局），一般需要 **1–3 周**。
- 备案通过后 **30 天内**还要做**公安联网备案**（全国互联网安全管理服务平台）。
- 备案期间网站不能解析到大陆服务器对外服务。建议：先用境外服务器上线，
  备案下来后再迁回大陆。

### 情况 B：服务器在境外（含中国香港 / 新加坡 / 美国等）

- **不需要 ICP 备案**。域名解析到境外服务器即可直接公网访问。
- 注意：境内访问境外服务器速度可能较慢；若主要用户在境内，长期看仍建议
  迁到大陆服务器并完成备案。

> 你目前用的是哪种服务器？告诉我位置，我可以把上面不适用的分支删掉，
> 只保留你要走的那条，并给出对应厂商的备案 / 解析具体步骤。

---

## 5. 前端对接说明

- 前端是**纯静态**站点，发布在 GitHub Pages，无需构建。
- `web/auth.js` 自动判断环境：
  - 域名是 `localhost` / `127.0.0.1` → 调 `http://127.0.0.1:8000`（本地后端）。
  - 其他（即线上 GitHub Pages）→ 调 `PROD_API`（默认 `https://hubapi.aerobeats.xyz`）。
- 登录状态、当前组织存在浏览器 `localStorage`（`bph_auth_token` / `bph_current_org`）。
- **库存双模式**：未登录 / 无组织时，库存用浏览器本地存储（保持现有 GitHub Pages
  站点零回归）；登录且选了组织后，库存改调服务器 API，按组织共享。
  首次进入组织库存会提示「把本地条目迁移到组织台账」（一次性）。
- 后端 `ALLOWED_ORIGINS` 必须包含前端站点来源（`https://aerobeats.github.io`），
  否则浏览器会因 CORS 拦截请求。

---

## 6. 日常运维

**查看日志 / 状态**

```bash
sudo systemctl status biopharma
sudo journalctl -u biopharma -f          # 实时日志
sudo journalctl -u biopharma --since "1 hour ago"
```

**更新代码后重启**

```bash
cd /opt/BioPharma_Hub
sudo git pull
cd server
sudo .venv/bin/pip install -r requirements.txt   # 依赖有变化时
sudo systemctl restart biopharma
```

**备份数据库**（建议每天 cron）

```bash
sudo -u postgres pg_dump biopharma_hub > /backup/biopharma_hub_$(date +%F).sql
# 恢复：
# sudo -u postgres psql biopharma_hub < /backup/biopharma_hub_2026-11-22.sql
```

**改密钥 / 改来源后**：编辑 `.env` → `sudo systemctl restart biopharma`。
改 `JWT_SECRET` 会让所有已登录用户的令牌失效（需重新登录），属正常。

---

## 7. API 概览

所有接口返回 JSON，含 `ok` 字段。需要认证的接口带 `Authorization: Bearer <token>`。

| 方法 | 路径 | 说明 | 权限 |
|------|------|------|------|
| GET | `/health` | 健康检查 | 公开 |
| POST | `/api/auth/register` | 注册（用户名/密码/显示名） | 公开 |
| POST | `/api/auth/login` | 登录，返回 token + 用户 + 组织列表 | 公开 |
| GET | `/api/auth/me` | 当前用户 + 组织 | 登录 |
| GET | `/api/orgs` | 我的组织列表 | 登录 |
| POST | `/api/orgs` | 用邀请码创建组织 | 登录 |
| POST | `/api/orgs/join` | 用组织码加入组织 | 登录 |
| GET | `/api/orgs/<id>` | 组织详情 + 成员 + 审计 | 成员 |
| PATCH | `/api/orgs/<id>` | 改组织信息 | 组织管理员 |
| POST | `/api/orgs/<id>/members/<mid>` | 改成员角色/职务 | 组织管理员 |
| DELETE | `/api/orgs/<id>/members/<mid>` | 移除成员 | 组织管理员 |
| GET | `/api/orgs/<id>/inventory` | 库存列表 | 成员 |
| POST | `/api/orgs/<id>/inventory` | 新增条目 | 可写角色（QA 除外） |
| POST | `/api/orgs/<id>/inventory/bulk` | 批量导入（≤5000） | 可写角色 |
| PATCH | `/api/orgs/<id>/inventory/<itemId>` | 改条目（版本+1，写审计） | 可写角色 |
| DELETE | `/api/orgs/<id>/inventory/<itemId>` | 软删除 | 可写角色 |
| POST | `/api/orgs/<id>/inventory/bulk-update` | 批量改 | 可写角色 |
| POST | `/api/orgs/<id>/inventory/bulk-delete` | 批量删 | 可写角色 |
| GET | `/api/admin/stats` | 全站统计 | 超级管理员 |
| GET | `/api/admin/users` | 用户列表 | 超级管理员 |
| POST | `/api/admin/invite-codes` | 生成组织邀请码 | 超级管理员 |
| GET | `/api/admin/invite-codes` | 邀请码列表 | 超级管理员 |
| GET | `/api/admin/orgs` | 所有组织 | 超级管理员 |

> 准确的路径 / 字段以 `server/routes/*.py` 为准。

---

## 8. 故障排查

| 现象 | 排查 |
|------|------|
| 前端提示「无法连接服务器」 | 后端没起 / 端口不对 / Cloudflare 没代理。`curl https://hubapi.aerobeats.xyz/health` 看是否通。 |
| 浏览器控制台 CORS 报错 | `.env` 的 `ALLOWED_ORIGINS` 没包含前端来源。加上 `https://aerobeats.github.io` 后重启。 |
| 登录返回 401 / 令牌失效 | `JWT_SECRET` 改过（旧令牌作废，重新登录即可）；或账号被禁用 / 删除。 |
| 500 数据库错误 | 看 `journalctl -u biopharma -f`。常见：`.env` 里 `DATABASE_URL` 密码错、PostgreSQL 没起、库没建。 |
| `init_admin` 报连接失败 | PostgreSQL 服务没起（`sudo systemctl start postgresql`）或 `.env` 数据库配置错。 |
| nginx 502 Bad Gateway | gunicorn 没在 8000 端口跑。`sudo systemctl status biopharma`，看 `journalctl`。 |
| 公网访问不了但本机能访问 | 防火墙没放行（`sudo ufw status`）；或大陆服务器没备案被拦截（见第 4 节）。 |

---

## 9. 文件结构

```
server/
├── app.py            # Flask 应用工厂（CORS / 蓝图 / 错误处理）
├── wsgi.py           # gunicorn 入口：wsgi:app
├── config.py         # 从 .env / 环境变量读配置
├── db.py             # engine / SessionLocal / init_db(create_all)
├── models.py         # ORM 模型（User/Organization/Membership/InviteCode/
│                     #   InventoryItem/AuditLog/Signature，GLP 对齐）
├── security.py       # bcrypt 哈希 / JWT / 角色权限装饰器
├── audit.py          # 写审计日志（只增不改）
├── codes.py          # 邀请码 / 组织码生成
├── init_admin.py     # 创建 / 提升超级管理员（建表 + 设密码）
├── smoke_test.py     # 后端自检（47 项断言）
├── requirements.txt  # Python 依赖
├── .env.example      # 配置模板（复制成 .env 填写，.env 不入库）
└── routes/
    ├── auth.py       # 注册 / 登录 / me
    ├── orgs.py       # 组织 CRUD / 加入 / 成员管理
    ├── admin.py      # 超管后台 / 邀请码
    └── inventory.py  # 按组织库存 API
```
