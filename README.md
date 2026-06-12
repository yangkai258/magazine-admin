# 杂志管理平台 / Magazine Admin CMS

多租户 SaaS 杂志分发 + 管理后台。Express + JSON 文件存储 + 阿里云 OSS。schema 当前版本 **v6**（v5 reader_secret + v6 AI 一句话生成画册骨架 + v6.1 AI 限速审计 + v6.2 PDF 智能解析）。

## 启动

```bash
npm install                                   # 自动装 pdf-img-convert（含 canvas native 依赖，见 PDF 依赖说明）
npm start                                     # 默认端口 50020（public）/ 50040（admin）
node scripts/start-50120.js                   # 端口 50100（public）/ 50120（admin）+ ADMIN_PASSWORD
```

环境变量：

| 变量 | 必填 | 说明 |
|------|------|------|
| `ADMIN_PORT` / `PUBLIC_PORT` | 否 | 监听端口，默认 50040 / 50020 |
| `ADMIN_PASSWORD` | 否 | 旧版 tenant-level fallback 密码 |
| `OSS_ACCESS_KEY_ID` / `OSS_ACCESS_KEY_SECRET` | 否 | 阿里云 OSS 凭证；缺了走本地 `uploads/` |
| `OSS_REGION` / `OSS_BUCKET` / `OSS_PREFIX` | 否 | OSS 区域 / bucket / 路径前缀 |
| `MAG_PUBLIC_BASE_URL` | 否 | 阅读端对外 URL（cloudflared tunnel / 域名 / 反代场景）；留空时按 req.host 推 |
| `MAG_PUBLIC_PORT` | 否 | 阅读端对外端口（默认 80） |
| `MINIMAX_API_KEY` | **v6 必填** | MiniMax M3 API Key，用于 AI 一句话生成画册骨架（`POST /api/admin/ai/skeleton`）与 v6.2 PDF 智能解析。**不要 commit 真实 key**。 |
| `MINIMAX_BASE_URL` | 否 | MiniMax API base URL，默认 `https://api.minimax.chat/v1` |
| `MINIMAX_MODEL` | 否 | 模型名，默认 `MiniMax-M3` |
| `MOCK_AI` | 否 | `1` 表示 LLM 走 mock（本地 e2e 联调，不打真实 API） |
| `AI_DAILY_LIMIT` | 否 | **v6.1** 每租户每日 AI 生成上限，默认 `20`。超限返回 `429`。mock 模式也走限速（同配额）。进程重启清空（内存限速，不持久化）。 |
| `PDF_MAX_PAGES` | 否 | **v6.2** PDF 解析最多抽多少页（截断），默认 `30`。 |
| `PDF_MAX_FILE_MB` | 否 | **v6.2** PDF 上传文件大小上限（MB），默认 `60`。 |

`.env` 示例（**只放占位符，真实 key 替换 `<your-key>`**）：

```
MINIMAX_API_KEY=<your-key>
# MINIMAX_BASE_URL=https://api.minimax.chat/v1
# MINIMAX_MODEL=MiniMax-M3
# MOCK_AI=1
# AI_DAILY_LIMIT=20
# PDF_MAX_PAGES=30
# PDF_MAX_FILE_MB=60
```

## 数据 / Schema

数据存 `server/db/data.json`，启动时若 schema_version < 当前版本会自动 backfill 缺失字段。`server/db/init.js` 的 `loadData()` 是兼容老数据的唯一入口。

- v5：`reader_secret`（阅读端 URL 鉴权）
- v6：`pages.title` / `pages.body` / `pages.is_skeleton`（AI skeleton 落库字段）
- v6.1：审计 `ai_generate_skeleton` / `ai_rate_limited` 字段
- v6.2：审计 `ai_pdf_import`（含 `pdf_bytes` / `pdf_pages_count` / `pdf_parse_warning` / `ai_warning` / `ai_model` / `pdf_parse_duration_ms` / `total_duration_ms` 等）

## 端到端测试

```bash
# 启动（带 mock LLM）
MOCK_AI=1 node server/index.js
# 跑 smoke test
node server/__e2e_ai_skeleton.js
# v6.2 PDF 解析离线 smoke test（不依赖 server 起来）
node scripts/test-pdf-parse.js
```

## 角色

- **平台管理员** (`tenant.is_platform_admin=true`)：跨租户管理
- **owner**：本租户全部能力（用户 / 杂志 / 品牌 / 阅读端 secret / 计费 / AI skeleton / PDF 导入）
- **editor**：杂志 / 页面编辑（无用户管理 / 计费）
- **viewer**：只读

## 文档

- `SPEC.md`：完整功能 / 数据模型 / API 文档（含 v6.0 AI skeleton + v6.1 限速 + v6.2 PDF 解析章节）

## PDF 依赖（v6.2）

`POST /api/admin/magazines/import-pdf` 走 `pdf-img-convert@^2.0.0` 抽 PDF 每页转 PNG buffer。
**重要**：该库**实际依赖** `canvas`（C++ native 模块） + `pdfjs-dist`（JS），与 README 描述的"纯 JS 免 ghostscript"不完全一致 —— 实际是"免 ghostscript，但需要 canvas native binary"。

### 装法

```bash
# Linux（推荐生产环境，prebuilt 齐全）
npm install
# 上面会自动跑 canvas 的 install 脚本（node-pre-gyp 下载 prebuilt）
# 若下载失败需 build：apt-get install -y libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev build-essential python3

# macOS
brew install pkg-config cairo pango libpng jpeg giflib librsvg
npm install

# Windows（开发机）
# 1) 安装 Visual Studio Build Tools（C++ workload + Windows SDK）
# 2) 安装 Python 3（node-gyp 需要）
# 3) npm install
# 4) 若 node-pre-gyp 仍报「No prebuilt binary」：用 nvm 切到 node 18.x 重装（24.x 的 prebuilt 覆盖率低）
```

### 降级路径（沙箱 / Windows 镜像无 canvas native binary）

`server/pdf-parser.js` 把错误归类为 `PdfRenderError`：
- `ERR_PDF_RENDER_DEP_MISSING`：canvas native binary 找不到（沙箱典型场景）。端点**不**阻断 200：仍创建 `enabled=0` 空壳 magazine + 0 页 + 返回 `warning` 字段给前端展示。
- `ERR_PDF_RENDER_FAILED`：PDF 损坏 / 加密 / 内存不足。端点同上，warning 字段。
- `ERR_PDF_EMPTY`：PDF 0 页。端点同上。

这样**沙箱里 npm install 失败 / 镜像漏装 canvas 也不会让 PDF 端点挂掉**；owner 看到 warning 后可：
- 切换到 Linux / 装好 canvas 的环境重试，或
- 直接在 `magazine/edit.html` 里手动给空壳 magazine 传图 + 填标题（**不依赖 PDF 解析**）

### PDF → 落库 链路

```
owner POST /api/admin/magazines/import-pdf (multipart, field=pdf)
  → multer memory storage (单文件, 60MB 上限, 仅 application/pdf)
  → 限速（继承 v6.1 ai_skeleton 桶：默认 20/天/租户，超限 429 + 写 ai_rate_limited 审计）
  → pdf-parser.parsePdfToPages({ buffer, maxPages=30, width=1200 })
    → dynamic import('pdf-img-convert')  ← ESM 包装,避免 CJS 互操作问题
    → convert(buffer, { page_numbers: [1..N], width: 1200 })
    → 返回 [{ index, imageBuffer, mime: 'image/png' }, ...]
  → 写本地 uploads/skeleton/<newId>/page-001.png ...
  → aiClient.analyzePdfPages({ pdfPages: [{page_index, image_path, mime}], locale: 'zh-CN' })
    → MiniMax M3 调 1 次（仍走 v6.1 限速）
    → system prompt: 「你是画册编辑，输出 JSON { pages: [{page_index, title, body}] }」
    → 强约束：page_index 1..N 连续、每页 title 5-20 字 + body 60-200 字
    → 失败重试 3 次（5s/15s/30s 退避）
  → createMagazine(enabled=0) + addPages(image_path, title, body, is_skeleton=true)
  → 审计 ai_pdf_import（pdf_bytes / pdf_pages_count / pdf_parse_warning / ai_warning / mock / rate_remaining）
  → 返回 { magazine, pages, pdf_meta, llm_meta, rate_limit, warning? }
```

### 新端点

`POST /api/admin/magazines/import-pdf`
- **auth**：`requireRole('owner')`
- **body**：`multipart/form-data`，field name = `pdf`，file = `application/pdf`（也接受 macOS Safari 的 `application/x-pdf`，按扩展名兜底）
- **size limit**：`PDF_MAX_FILE_MB`（默认 60）
- **200 成功**（含降级）：`{ magazine, pages, pdf_meta:{ filename, bytes, pages_extracted, max_pages, parse_duration_ms }, llm_meta, rate_limit, warning? }`
- **400 校验**：未传文件 / 文件名 / mimetype 不匹配
- **401 未登录**：`AUTH_REQUIRED`
- **403 角色错**：`ROLE_REQUIRED`
- **413 文件过大**：`PDF 文件超过 XMB 上限`
- **415 媒体类型错**：`仅支持 PDF 文件`
- **429 限速**：`已达今日 AI 生成上限（N 次），明天 0 点重置`
- **500 LLM/落库失败**：含 rollback（删空壳 magazine + skeleton 目录）
