# 杂志管理平台 / Magazine Admin CMS

多租户 SaaS 杂志分发 + 管理后台。Express + JSON 文件存储 + 阿里云 OSS。schema 当前版本 **v6**（v5 reader_secret + v6 AI 一句话生成画册骨架）。

## 启动

```bash
npm install
npm start                                 # 默认端口 50020（public）/ 50040（admin）
node scripts/start-50120.js               # 端口 50100（public）/ 50120（admin）+ ADMIN_PASSWORD
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
| `MINIMAX_API_KEY` | **v6 必填** | MiniMax M3 API Key，用于 AI 一句话生成画册骨架（`POST /api/admin/ai/skeleton`）。**不要 commit 真实 key**。 |
| `MINIMAX_BASE_URL` | 否 | MiniMax API base URL，默认 `https://api.minimax.chat/v1` |
| `MINIMAX_MODEL` | 否 | 模型名，默认 `MiniMax-M3` |
| `MOCK_AI` | 否 | `1` 表示 LLM 走 mock（本地 e2e 联调，不打真实 API） |

`.env` 示例（**只放占位符，真实 key 替换 `<your-key>`**）：

```
MINIMAX_API_KEY=<your-key>
# MINIMAX_BASE_URL=https://api.minimax.chat/v1
# MINIMAX_MODEL=MiniMax-M3
# MOCK_AI=1
```

## 数据 / Schema

数据存 `server/db/data.json`，启动时若 schema_version < 当前版本会自动 backfill 缺失字段。`server/db/init.js` 的 `loadData()` 是兼容老数据的唯一入口。

- v5：`reader_secret`（阅读端 URL 鉴权）
- v6：`pages.title` / `pages.body` / `pages.is_skeleton`（AI skeleton 落库字段）

## 端到端测试

```bash
# 启动（带 mock LLM）
MOCK_AI=1 node server/index.js
# 跑 smoke test
node server/__e2e_ai_skeleton.js
```

## 角色

- **平台管理员** (`tenant.is_platform_admin=true`)：跨租户管理
- **owner**：本租户全部能力（用户 / 杂志 / 品牌 / 阅读端 secret / 计费 / AI skeleton）
- **editor**：杂志 / 页面编辑（无用户管理 / 计费）
- **viewer**：只读

## 文档

- `SPEC.md`：完整功能 / 数据模型 / API 文档（含 v6.0 AI skeleton 章节）