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
DNS 解析  hubapi.aerobeats.xyz ──(Cloudflare 灰云/仅解析)──► 阿里云公网 IP
  │  ③ 直连你的服务器（境内阿里云，需 ICP 备案）
  ▼
nginx (80；备案后 certbot 加 443/Let's Encrypt) ──► gunicorn (127.0.0.1:8000) ──► Flask app
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

### 3.0 境内部署顺序（重要）

服务器在中国大陆（阿里云）时，**备案通过前阿里云会拦截该域名的 80/443 公网访问**。
所以分两步走，你现在就能把第一步全部做完：

- **现在可做（备案前）**：3.1 装软件 → 3.2 建库 → 3.3 拉代码 → 3.4 配 `.env`
  → 3.5 建表/超管 → 3.6 gunicorn+systemd → 3.7 nginx(HTTP) → 3.9 防火墙+**阿里云安全组**
  → 3.8 的「DNS 解析」部分。全程在**服务器本机**用 `curl http://127.0.0.1/health` 验证。
- **备案通过后**：3.8 的「Let's Encrypt HTTPS」部分（certbot 需要 80 端口可达，必须等备案放行），
  然后从线上站点做端到端验证。

> 备案要 1–3 周，建议**先按上面把服务部署好、本机测通**，再去提交备案，两不耽误。

### 3.1 安装基础软件

Debian / Ubuntu 通用：

```bash
sudo apt update
sudo apt install -y python3 python3-venv python3-pip postgresql nginx certbot python3-certbot-nginx
```

确认 Python ≥ 3.11：`python3 --version`（Debian 12 自带 3.11，Debian 11 是 3.9，
需自行装 3.11，例如用 `apt install python3.11 python3.11-venv` 或 pyenv）。
`certbot` 现在装好备用，备案后再用它签 HTTPS 证书。

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

仓库里已备好服务文件 `server/deploy/biopharma.service`，直接复制过去即可
（如果你没把代码放在 `/opt/BioPharma_Hub`，先改文件里的两处路径）：

```bash
sudo cp /opt/BioPharma_Hub/server/deploy/biopharma.service /etc/systemd/system/biopharma.service
# 若代码不在 /opt/BioPharma_Hub，编辑里面的 WorkingDirectory 与 ExecStart 路径：
# sudo nano /etc/systemd/system/biopharma.service
```

文件内容（供参考）：

```ini
[Unit]
Description=BioPharma Hub backend (gunicorn)
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=root
Group=root
WorkingDirectory=/opt/BioPharma_Hub/server
ExecStart=/opt/BioPharma_Hub/server/.venv/bin/gunicorn --bind 127.0.0.1:8000 --workers 2 --timeout 60 wsgi:app
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

> 说明：用 `Type=simple` 最稳（`Type=notify` 在部分 gunicorn 版本会因收不到就绪通知而启动超时）。
> 应用通过 python-dotenv 按绝对路径自动读取 `server/.env`，所以**不需要** `EnvironmentFile`。
> 以 root 运行最省事；若想更安全，可建专用用户并改 `User`/`Group`，同时确保该用户能读代码与 `.env`。

启用并启动：

```bash
sudo systemctl daemon-reload
sudo systemctl enable biopharma
sudo systemctl start biopharma
sudo systemctl status biopharma     # 应显示 active (running)
```

本机自测（不经 nginx，直接打 gunicorn）：

```bash
curl http://127.0.0.1:8000/health
# 期望：{"db":"postgresql","ok":true,"service":"biopharma-hub-backend"}
```

### 3.7 nginx 反向代理

仓库里已备好站点配置 `server/deploy/nginx-biopharma.conf`（先只跑 HTTP，备案后 certbot 会自动加 HTTPS）：

```bash
sudo cp /opt/BioPharma_Hub/server/deploy/nginx-biopharma.conf /etc/nginx/sites-available/biopharma
# 若子域名不是 hubapi.aerobeats.xyz，改里面的 server_name：
# sudo nano /etc/nginx/sites-available/biopharma
sudo ln -s /etc/nginx/sites-available/biopharma /etc/nginx/sites-enabled/
sudo nginx -t          # 应显示 syntax ok / test successful
sudo systemctl reload nginx
```

配置内容（供参考）：

```nginx
server {
    listen 80;
    listen [::]:80;
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

本机自测（经 nginx）：

```bash
curl -H "Host: hubapi.aerobeats.xyz" http://127.0.0.1/health
# 期望同上的 JSON。备案前从公网访问会被阿里云拦截，本机测通即可。
```

### 3.8 DNS 解析 + HTTPS（Let's Encrypt）

境内服务器**不要用 Cloudflare 橙云代理**（会和备案冲突、且境内访问绕境外更慢）。
正确做法：域名直接解析到阿里云 IP + 用 Let's Encrypt 免费证书。

**第一步：DNS 解析（现在就能做，备案也需要它）**

你的 `aerobeats.xyz` DNS 托管在 Cloudflare，去 Cloudflare 加一条记录：

- 登录 Cloudflare → 选 `aerobeats.xyz` → **DNS** → **Add record**：
  - Type: `A`，Name: `hubapi`，Content: `你的阿里云公网IP`
  - **Proxy status: DNS only（灰色云朵）** ← 关键！灰云 = 只解析不代理，
    域名直接指向阿里云 IP，备案核验才认；橙云会指向 Cloudflare，备案过不了。

等几分钟，验证解析：

```bash
nslookup hubapi.aerobeats.xyz   # 期望返回你的阿里云公网 IP
```

**第二步：HTTPS 证书（备案通过后再做）**

备案通过、阿里云放行 80/443 后，用 certbot 一条命令签证书并自动改好 nginx：

```bash
sudo certbot --nginx -d hubapi.aerobeats.xyz
# 按提示填邮箱、同意条款；选「把 HTTP 重定向到 HTTPS」(通常按 2)。
# certbot 会自动改 /etc/nginx/sites-available/biopharma 加上 443，并装好自动续期。
```

验证自动续期（证书 90 天有效，certbot 定时自动续）：

```bash
sudo certbot renew --dry-run
```

然后浏览器访问，应返回后端 JSON：

```
https://hubapi.aerobeats.xyz/health
→ {"ok":true,"service":"biopharma-hub-backend","db":"postgresql"}
```

> 前端 `web/auth.js` 里的生产地址是 `https://hubapi.aerobeats.xyz`。
> 如果你的子域名不是这个，改 `auth.js` 顶部的 `PROD_API` 常量即可（改完前端要重新部署）。

> 为什么备案前不能签证书：certbot 默认用 HTTP-01 验证，需要 Let's Encrypt 从公网访问
> `http://hubapi.aerobeats.xyz/.well-known/...`，而备案前阿里云拦截 80，验证会失败。
> 真想在备案前备好证书，可改用 DNS-01（`certbot-dns-cloudflare` 插件，走 Cloudflare API
> 加 TXT 记录验证，不需要 80 端口）——但通常没必要，等备案后签最省事。

### 3.9 防火墙（两层都要放行）

阿里云有**两道**防火墙，新手最常栽在这里——只开了系统防火墙、忘了控制台安全组，
结果本机 curl 通、公网就是访问不了。**两道都要放行 22 / 80 / 443。**

**第一道：阿里云安全组（在控制台点，不是命令）**

1. 阿里云控制台 → ECS → 你的实例 → **安全组** → 配置规则 → **入方向** → 手动添加：
   - `22/TCP`（SSH，授权对象建议限制成你自己的 IP，更安全）
   - `80/TCP`（HTTP，授权对象 `0.0.0.0/0`）
   - `443/TCP`（HTTPS，授权对象 `0.0.0.0/0`）
2. **不要**放行 `5432`（PostgreSQL）和 `8000`（gunicorn）——它们只在本机用。

**第二道：服务器系统防火墙 ufw**

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'   # 同时放行 80 和 443
sudo ufw enable
sudo ufw status               # 确认 22/80/443 为 ALLOW
```

> 务必先确认 SSH(22) 已放行再 `ufw enable`，否则可能把自己锁在门外。

**PostgreSQL 只绑本机**：`sudo nano /etc/postgresql/*/main/postgresql.conf`，
确认 `listen_addresses = 'localhost'`（Debian 默认即是）。**绝不**把 5432 暴露公网。

---

## 4. ICP 备案（境内阿里云，必做）

你的服务器在**中国大陆（阿里云）**，绑定公网域名 `aerobeats.xyz` **必须做 ICP 备案**，
否则阿里云会拦截该域名的 80/443，公网访问不了。**部署可以现在做完，备案随后提交。**

### 备案前准备

- 域名 `aerobeats.xyz` 已实名（在域名注册商处完成实名认证）。
- 已按 3.8 把 `hubapi` 用 **Cloudflare 灰云（DNS only）** 解析到阿里云公网 IP
  （管局/阿里云会核验域名确实指向你这台阿里云服务器）。
- 阿里云 ECS 为**包年包月**且剩余时长 ≥ 3 个月（按量付费实例通常不能备案）。
- 备好：身份证、手机号、邮箱；个人备案需本人核验（阿里云 App 拍照 / 人脸识别）。

### 提交备案（走阿里云）

1. 阿里云控制台搜「**ICP 备案**」→ 进入备案系统（beian.aliyun.com）→ 开始备案。
2. 主体信息选「**个人**」（你是个人开发者；以后若用公司主体再改企业备案）。
3. 网站信息：填 `aerobeats.xyz`，服务内容选「非经营性」。
4. 阿里云会给你一个**备案服务号**（每台符合条件的 ECS 可申请），按提示填入。
5. 上传证件、完成本人核验 → 提交阿里云初审（1–2 个工作日）→ 阿里云代提交管局。
6. 管局审核一般 **1–3 周**（各省不同），期间保持手机畅通，可能接到核验电话。
7. 通过后拿到**备案号**（如「某ICP备XXXXXXXX号」）。

### 备案通过后

- **30 天内**做**公安联网备案**：登录「全国互联网安全管理服务平台」
  （beian.mps.gov.cn）按指引提交，拿到公安备案号。
- 按 3.8 第二步用 certbot 开 HTTPS。
- 备案号建议放在前端站点页脚（管局要求网站底部展示备案号并链接到工信部系统）。

> 备案期间这台服务器的域名公网访问被拦属正常。可先在**服务器本机**用
> `curl http://127.0.0.1/health` 确认服务正常，备案通过后立即对外可用。
> 现有 GitHub Pages 站点与 Cloudflare Worker（`api.aerobeats.xyz`）都在境外，不受影响、无需备案。

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
| 前端提示「无法连接服务器」 | 后端没起 / DNS 没解析到阿里云 IP / 没备案被拦。先 `curl https://hubapi.aerobeats.xyz/health`，再在服务器本机 `curl http://127.0.0.1/health` 逐层定位。 |
| 浏览器控制台 CORS 报错 | `.env` 的 `ALLOWED_ORIGINS` 没包含前端来源。加上 `https://aerobeats.github.io` 后重启。 |
| 登录返回 401 / 令牌失效 | `JWT_SECRET` 改过（旧令牌作废，重新登录即可）；或账号被禁用 / 删除。 |
| 500 数据库错误 | 看 `journalctl -u biopharma -f`。常见：`.env` 里 `DATABASE_URL` 密码错、PostgreSQL 没起、库没建。 |
| `init_admin` 报连接失败 | PostgreSQL 服务没起（`sudo systemctl start postgresql`）或 `.env` 数据库配置错。 |
| nginx 502 Bad Gateway | gunicorn 没在 8000 端口跑。`sudo systemctl status biopharma`，看 `journalctl`。 |
| 公网访问不了但本机能访问 | ① 阿里云**安全组**没放行 80/443（最常见，见 3.9）② ufw 没放行（`sudo ufw status`）③ 域名没用**灰云**解析到阿里云 IP（见 3.8）④ 没备案被阿里云拦截（见第 4 节）。 |
| certbot 签证书失败 | 多为备案前 80 被拦（HTTP-01 验证不通）→ 等备案后再签；或 DNS 没解析到本机、安全组没放行 80。 |

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
├── deploy/
│   ├── biopharma.service     # systemd 服务模板 → 复制到 /etc/systemd/system/
│   └── nginx-biopharma.conf  # nginx 站点模板 → 复制到 /etc/nginx/sites-available/
└── routes/
    ├── auth.py       # 注册 / 登录 / me
    ├── orgs.py       # 组织 CRUD / 加入 / 成员管理
    ├── admin.py      # 超管后台 / 邀请码
    └── inventory.py  # 按组织库存 API
```
