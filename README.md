# BioPharma Hub

生物医药行业资讯聚合与实验 Protocol 辅助设计平台。实时聚合全球生物制药领域新闻（研发、审批、市场、技术），提供结构化 Protocol 模板生成与 AI 智能优化建议。

**在线演示**: https://aerobeats.github.io/BioPharma_Hub/

## 功能特性

- **新闻聚合**: 每小时自动抓取 Nature Biotechnology、Nature Medicine、STAT News 等 7 个权威源，英文标题自动翻译为中文
- **Protocol 设计**: 内置 PCR、质粒构建、细胞培养、ELISA 等实验模板，填写参数即可生成结构化文档
- **AI 智能优化**: 基于 Qoder AI 模型，针对 Protocol 草稿给出专业改进建议（需部署 Cloudflare Worker）
- **小工具**: PDF/Markdown 互转、序列格式化工具（浏览器本地运行，无需上传）
- **英语学习**: 生物医药术语卡片与阅读练习

## 架构概览

```
BioPharma_Hub/
├── web/                    # 静态前端 (HTML/CSS/JS)
│   ├── index.html          # 单页应用入口
│   ├── app.js              # 路由 + 视图逻辑
│   ├── templates.js        # Protocol 模板定义
│   └── data/               # 静态数据 (由脚本生成)
│       ├── news.json       # 新闻聚合结果
│       └── translations.json # 翻译缓存
├── scripts/
│   └── fetch_news.py       # RSS 抓取 + 翻译脚本
├── worker/
│   └── worker.js           # Cloudflare Worker (AI 后端)
└── .github/workflows/
    ├── update-news.yml     # 每小时更新新闻数据
    └── deploy-pages.yml    # GitHub Pages 自动部署
```

**前端**: 纯静态 HTML/CSS/JS，无框架依赖，通过 `import.meta.url` 相对路径加载数据
**新闻管道**: Python stdlib (`urllib` + `xml.etree`) → MyMemory API (主) / Google gtx (备) → 持久化 JSON
**AI 后端**: Cloudflare Workers，调用 Qoder Chat Completions API，密钥存于 Workers Secret

## 本地开发

### 前置条件

- Python 3.11+
- Git

### 启动开发服务器

```bash
python dev/server.py 8080
```

访问 http://127.0.0.1:8080

- 新闻 RSS 代理: `/functions/v1/app/news` (实时抓取，带缓存)
- AI 接口: `/functions/v1/app/protocol/enhance` (返回 ai_not_configured，需部署后端)

### 手动生成新闻数据

```bash
python scripts/fetch_news.py
```

输出到 `web/data/news.json` 和 `web/data/translations.json`

可选参数:
- `--out <path>`: 指定输出路径
- `--no-translate`: 跳过翻译（快速测试）

环境变量:
- `MYMEMORY_EMAIL`: 提升 MyMemory API 每日配额（可选）

## GitHub Pages 部署

本项目托管于 GitHub Pages，通过 GitHub Actions 实现自动化部署与数据更新。

### 首次设置

1. **启用 Pages**: Settings → Pages → Source 选 **GitHub Actions**
2. **创建 PAT** (Personal Access Token):
   - 访问 https://github.com/settings/tokens
   - 新建 Classic token，勾选 `repo` 权限
   - 复制 token，在仓库 Settings → Secrets and variables → Actions 中添加 Secret: `PERSONAL_TOKEN`
3. **推送代码**:
   ```bash
   git remote add origin https://github.com/<你的用户名>/BioPharma_Hub.git
   git push -u origin main
   ```

### 自动化流程

- **update-news.yml**: 每小时执行一次 (`cron: "5 * * * *"`)
  1. 运行 `scripts/fetch_news.py` 抓取 RSS 并翻译
  2. 用 `PERSONAL_TOKEN` 提交 `web/data/news.json` 和 `translations.json`
  3. 该提交会触发 `deploy-pages.yml`

- **deploy-pages.yml**: 监听 `push` 到 `main` 分支
  1. 构建静态资源 (直接打包 `web/` 目录)
  2. 上传为 Pages artifact
  3. 部署到 GitHub Pages

> **为什么需要 PAT?** GitHub 故意阻止由 `GITHUB_TOKEN` 创建的提交触发其他工作流，以避免无限循环。使用 PAT 推送的提交会被视为普通用户操作，从而正常触发部署。

### 常见问题

**Q: 网页内容没更新，但 repo 里 data 已更新**
- 检查 Actions 标签页，确认 `deploy-pages` 工作流是否成功运行
- 如果看到 `[skip ci]` 在提交信息中，该提交会跳过所有工作流（已修复，不再添加此标记）

**Q: Push 被拒绝 "non-fast-forward"**
- 远程有 github-actions[bot] 的新闻提交，先拉取再推送:
  ```bash
  git pull --rebase origin main
  git push
  ```

**Q: AI 优化提示 "Unexpected token '<'"**
- 这是静态托管下访问不存在的 `/functions/v1/app/protocol/enhance` 返回 HTML 404
- 需要部署 Cloudflare Worker 后端（见下文）

## Cloudflare Workers AI 后端部署

AI 智能优化功能依赖后端服务，部署到 Cloudflare Workers（免费额度足够个人使用）。

### 部署步骤

1. **创建 Worker**
   - 打开 https://dash.cloudflare.com → Workers & Pages → Create → Create Worker
   - 名字填 `biopharma-ai` → Deploy
   - 点击 Edit code，清空默认内容，粘贴 [worker/worker.js](worker/worker.js) 的完整代码 → Deploy

2. **配置密钥**
   - 进入 Worker → Settings → Variables and Secrets
   - 添加 **Secret**: `QODER_PAT` = 你的 Qoder Personal Access Token
   - 添加 Variable (Text): `ALLOWED_ORIGINS` = `https://aerobeats.github.io` (多个域名用逗号分隔)

3. **获取域名**
   - Worker 页面顶部显示地址，如 `https://biopharma-ai.<子域>.workers.dev`
   - 验证: 浏览器打开 `https://biopharma-ai.<子域>.workers.dev/health`
     应返回 `{"ok":true,"service":"biopharma-hub-ai"}`

4. **前端配置**
   - 修改 [web/app.js](web/app.js) 顶部的 `AI_ENDPOINT`:
     ```js
     const AI_ENDPOINT = "https://biopharma-ai.<子域>.workers.dev";
     ```
   - 提交并推送:
     ```bash
     git add web/app.js
     git commit -m "feat: configure AI backend endpoint"
     git push
     ```

### 安全说明

- **QODER_PAT 必须存为 Secret**，不会出现在代码或前端
- Worker 只允许白名单域名发起请求（CORS 校验）
- 如需轮换 PAT，直接在 Cloudflare 控制台修改 Secret，无需重新部署代码

## 许可证

MIT

## 作者

AeroBeats (中国药科大学生物技术专业)
