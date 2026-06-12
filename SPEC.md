# 杂志管理平台 - Magazine Admin CMS

## 概念与愿景

多租户 SaaS 杂志管理平台。**平台管理员**统一管租户、看审计、看跨租户数据；**租户**用自己的 owner / editor / viewer 账号登录后台管自己的杂志、封面、品牌、订阅；**公共阅读端**通过 URL secret 鉴权（`?t=<slug>&s=<secret>`）只让拿到链接的读者访问本租户的杂志和封面。

Schema 演进：v3（多租户 + 平台管理员）→ v4（基于 user 的鉴权 + 角色 + plans / subscriptions / 自助注册）→ **v5（reader_secret 公共 API 鉴权 + 品牌定制 + 跨端 secret 管理）**。

## 技术栈

- **后端**: Express.js + JSON 文件存储（schema v5）
- **前端**: 原生 HTML / CSS / JS，无框架依赖；admin 端共享 `nav.js` / `topbar.js` + Lucide 图标
- **文件存储**: 阿里云 OSS（凭证从 `.env` 读），封面 / 杂志页 / 品牌 logo 都直传 OSS
- **部署**: 单机双服务，admin `50120` / public `50100`（env 可覆盖；老配置 `50020/50040` 已废弃）
- **会话**: 内存 Map，24h TTL 滑动续期，cookie 名 `mag_admin_sid`

## 角色

| 角色 | 归属 | 能力 |
|------|------|------|
| **平台管理员** (`tenant.is_platform_admin=true`) | 平台内置 tenant | 管所有租户、跨租户看数据、看所有审计 / 邮件日志、读者 secret 也归他管 |
| **租户 owner** | 业务 tenant | 管本租户用户邀请 / 角色、杂志 / 封面 / 品牌定制 / 阅读端 secret / 订阅与计费 / 看本租户阅读分析 |
| **租户 editor** | 业务 tenant | 管本租户杂志 / 封面 / 页面（不能动用户、品牌、订阅、secret） |
| **租户 viewer** | 业务 tenant | 只读，看本租户数据 |
| **公共读者** | 访客 | 通过 `?t=<slug>&s=<secret>` 鉴权后读本租户启用杂志和封面，server 自动 track 阅读分析 |

## 数据模型（schema v5）

### Tenant（租户）
| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER | 主键 |
| slug | TEXT | 唯一 URL 标识（小写 a-z 0-9 -） |
| name | TEXT | 显示名 |
| password | TEXT | 租户级 fallback 密码（v3 遗留；v4 后主要走 user 表） |
| is_platform_admin | BOOL | true = 平台管理员（单租户内置） |
| suspended | BOOL | true = 暂停（公共 API 隐藏所有数据 + 拒绝登录） |
| logo_url | TEXT | OSS 上品牌 logo URL |
| primary_color | TEXT | 品牌主色（`#RGB` / `#RRGGBB`） |
| plan_id | INT | 当前 plan |
| subscription_status | TEXT | `active` / `past_due` / `canceled` |
| trial_ends_at | TEXT | ISO |
| **reader_secret** | TEXT（32 字符 base64url） | **v5：阅读端 URL 鉴权 secret** |
| **reader_secret_created_at** | TEXT | ISO |
| **reader_secret_updated_at** | TEXT | ISO |
| created_at | TEXT | ISO |

> `loadData()` 兼容老租户缺 `reader_secret`：自动生成 32 字符 base64url（24 字节熵）并立即持久化，**server 重启后 link 仍然稳定可用**。

### User（v4 新增）
| 字段 | 说明 |
|------|------|
| id, tenant_id, email, name, role, status, password_hash, last_login_at, created_at | owner / editor / viewer |

`password_hash = SHA-256("mag-static-salt-v4" + password)`（生产应换 bcrypt / argon2）

### Plan / Subscription / Invoice（v4 计费）
- `plan` 三档：`free` / `pro` / `enterprise`，每档有 `max_magazines` / `max_pages_per_magazine` / `max_storage_mb` / `has_custom_branding` / `has_analytics` / `max_users` 等 features
- `subscription`（租户当前订阅，过期时间）
- `invoice`（账单：pending / paid / failed / refunded）
- `payment_method`（租户绑定的支付方式：alipay / wechat）
- 没配支付 key 时走 mock：`/api/admin/payment/mock-paid` 直接 mark paid，email_log 记 pending

### Magazine / Page / Cover
同 v3 + `tenant_id` 隔离。`enabled=1` 的杂志对公共 API 可见。

### Reader Analytics（v4 新增）
- `event_type`：`view` / `dwell` / `complete`
- `viewer_id`（localStorage 匿名 hash）、`duration_ms`（毫秒）、`referrer`、`user_agent`
- 限 50000 条，超出截断
- admin 端 `/admin/analytics.html` 看板：总览 + 按杂志聚合

### Signup / Password Reset / Invitation Tokens（v4）
- `signup_token` 24h 过期，自助注册流程
- `password_reset_token` 1h 过期
- `user_invitation` 72h 过期，邀请新用户

### Email Log（v4）
- 全部外发邮件的存档：`to_email` / `subject` / `body` / `status`（sent / failed / pending）/ `error`
- 没配 SMTP 时 `console.log` + status `pending`
- 限 5000 条

### Audit Log（v3 → v5 扩展）
字段：`id` / `timestamp` / `actor_user_id` / `actor_user_email` / `actor_tenant_id` / `actor_tenant_slug` / `actor_is_platform_admin` / `actor_role` / `tenant_id`（被影响租户） / `action` / `target_type` / `target_id` / `details` / `ip` / `user_agent`

action 集合：login / login_failed / logout / create_tenant / update_tenant / delete_tenant / suspend_tenant / unsuspend_tenant / **update_branding**（v4） / **regenerate_reader_secret**（v5） / create_magazine / update_magazine / delete_magazine / add_page / add_pages_batch / reorder_pages / delete_page / create_cover / delete_cover / upload_file / publish / create_user / update_user / delete_user / create_invitation / accept_invitation / create_subscription / create_invoice / mark_paid 等

> 保留最近 10000 条。

## 端口

| 端口 | 服务 | env 覆盖 | 备注 |
|------|------|---------|------|
| `50100` | 公共阅读端 + 公共读 API | `PUBLIC_PORT` | 旧 `50020` 已废弃 |
| `50120` | 管理后台 + 后台 API | `ADMIN_PORT` | 旧 `50040` 已废弃 |

启动脚本：`scripts/start-50120.js`（Node 包装器进程内 setenv）+ `C:\Users\YKing\start-server-50120.bat` 快捷启动

## 关键 API

### Auth（基于 user，v4 重写）
- `POST /api/auth/login {slug, email, password}` → Set-Cookie `mag_admin_sid`
- `POST /api/auth/logout` → 清 cookie
- `GET  /api/auth/me` → 当前 user + tenant
- `POST /api/auth/forgot-password` / `POST /api/auth/reset-password`
- `POST /api/auth/accept-invite`（邀请链接兑现）

### 平台管理（`requirePlatformAdmin`）
- `GET    /api/admin/tenants`
- `POST   /api/admin/tenants {slug, name, password?, is_platform_admin?}`
- `PUT    /api/admin/tenants/:id`
- `POST   /api/admin/tenants/:id/suspend` / `unsuspend`
- `DELETE /api/admin/tenants/:id`（级联删数据）
- `GET    /api/admin/audit-logs?tenantId=&actorUserId=&action=&limit=&offset=`
- `GET    /api/admin/email-log?to_email=&status=&limit=&offset=`

### 租户自身管理（`requireRole('owner')`）
- `GET    /api/admin/tenant/users`
- `POST   /api/admin/tenant/users {email, role, password, name}`
- `PUT    /api/admin/tenant/users/:id {role?, name?, password?}`
- `DELETE /api/admin/tenant/users/:id`
- `POST   /api/admin/tenant/users/invite {email, role}`
- `GET    /api/admin/tenant/invitations`
- `GET    /api/admin/tenant/reader-secret` → `{secret, link, tenant_slug, created_at, updated_at}`（**v5 新增**）
- `POST   /api/admin/tenant/reader-secret/regenerate` → 同上 + 写 audit（**v5 新增**）
- `GET    /api/admin/branding` → `{name, slug, logo_url, primary_color}`（v4）
- `PUT    /api/admin/branding`（multipart `logo` + `primary_color`）→ owner only（v4）
- `GET    /api/admin/plans`（v4）
- `GET    /api/admin/subscription`（v4）
- `GET    /api/admin/invoices`（v4）
- `POST   /api/admin/payment/create`（v4 mock 支付）
- `POST   /api/admin/payment/mock-paid`（v4）
- `GET    /api/admin/analytics?since=...`（v4）

### 杂志 / 页 / 封面 CRUD（`requireAuth`，按 tenant 隔离）
- 旧 API 全部保留：`/api/magazines` / `/api/magazines/:id/pages` / `/api/covers/upload` 等
- 平台管理员可加 `?tenantId=X` 跨租户看
- 所有写操作自动 audit log

### 自助注册（无需鉴权，v4）
- `POST /api/public/signup {email, tenant_slug, tenant_name, plan_id}` → 24h verify token + 发邮件
- `GET  /api/public/signup/verify?token=xxx` → 创建 tenant + owner user + 返初始密码

### 公共读（v5：必须带 reader_secret 鉴权）
- `GET /api/public/data?slug=<slug>&secret=<secret>` → 200 + 单租户 live 快照，401 缺/错
  - 也支持 header `X-Reader-Secret: xxx`（前端默认用这个）
- `GET /api/public/tenants/<slug>/magazines?secret=xxx`
- `GET /api/public/tenants/<slug>/magazines/<id>?secret=xxx`
- `GET /api/public/tenants/<slug>/cover?type=pc|mobile&secret=xxx`
- `GET /api/public/tenants?secret=xxx`（鉴权后返所有非暂停租户）
- `POST /api/public/analytics/track {tenant_slug, secret, magazine_id, page_id, event_type, page_number, duration_ms, viewer_id}` → 失败 silently 返 `{success: false}`，不泄漏爬虫探测
- `GET /api/public/plans` → 公开（注册页用）
- `POST /api/public/signup` / `GET /api/public/signup/verify` → 公开

> 响应里**绝不**含 `reader_secret`（防泄漏）

### Publish（v3 遗留，可选缓存层）
- `POST /api/admin/publish` → 把 data 推 OSS（5min CDN 缓存）
- 默认不需要：阅读端直接拉 `/api/public/data` 是 live 的，admin 改完刷新立刻见

## 阅读端鉴权流程（v5 核心）

```
[Admin 端]                                                [阅读者]
                                                            
1. owner 进入「品牌定制」页                         
2. 看到「🔗 阅读端分享链接」卡                      
3. 点「📋 复制链接」                               
   → http://<host>:50100/?t=zhuobao&s=ebnAAR_Ttp...
4. 发链接给读者                                       5. 打开链接
                                                     6. splash.html 读 ?s=xxx
                                                     7. MAG_READER_AUTH.init()
                                                        存 localStorage
                                                     8. 后续 fetch 加 X-Reader-Secret header
9. 旧链接泄漏？点「🔄 重新生成」                    
   → 调 POST /api/admin/tenant/reader-secret/regenerate
   → 旧 secret 立即失效（所有拿着旧链接的人 401）
```

### `MAG_READER_AUTH` Helper（`public/reader/secret.js`，117 行）
- `init()`：从 `?s=xxx` 读 → 写 localStorage `mag_reader_secret`
- `getSecret()`：返当前 secret
- `clear()`：401 时清 localStorage
- `fetch(url, options)`：包装 fetch，自动注入 `X-Reader-Secret` header；401 拦截 + 派发 `reader:auth_failed` 事件

### 三页阅读端
- `splash.html` / `directory.html` / `reader/viewer.html` 都引 `reader/secret.js`，启动时调 `init()`，所有 fetch 走 `MAG_READER_AUTH.fetch`
- 跨页跳转的 URL 都把 `&s=xxx` 拼上（splash → directory → viewer）
- 401 监听 `reader:auth_failed` → 显示「链接无效，请联系客户获取正确链接」提示页
- 无 `?s=` + 无 localStorage → 显示「请通过客户提供的链接访问」

## 后台 UI 页面

| 页面 | 谁可见 | 功能 |
|------|--------|------|
| `/admin/login.html` | 任何人 | 登录（支持 slug + email + password） |
| `/admin/index.html` | 登录后 | 总览 + 统计卡 + SaaS 模式说明 |
| `/admin/magazine/list.html` | 登录后 | 杂志列表（平台管理员可看 `?tenantId=`） |
| `/admin/magazine/edit.html?id=X` | editor / owner | 杂志编辑 + 页面管理（拖拽排序） |
| `/admin/cover/list.html` | editor / owner | 封面管理（PC + mobile 横幅） |
| `/admin/branding.html` | **owner** | 品牌定制（logo + 主色 6 预设 + 自定义）+ **v5 阅读端分享链接卡** |
| `/admin/tenant-users.html` | **owner** | 租户内用户管理（邀请 / 改角色 / 改密码） |
| `/admin/billing.html` | **owner** | 订阅与计费（plan 选择 / mock 支付） |
| `/admin/analytics.html` | 登录后 | 阅读分析（总览 + 按杂志聚合） |
| `/admin/platform.html` | **平台管理员** | 租户列表 + CRUD + 暂停/恢复/删除 |
| `/admin/audit.html` | **平台管理员** | 审计日志查看 + 筛选 + 分页 |
| `/admin/email-log.html` | **平台管理员** | 邮件日志查看 |
| `/admin/signup-verify.html` | 任何人 | 自助注册验证页（点邮件链接后） |

后三个页面对非 platform admin 隐藏侧边栏入口（`display:none` + `MAG_NAV.render()` role 过滤）。
nav 由 `js/nav.js` 单一权威 10 项列表渲染 + Lucide 图标。

## 阅读端（公共）

3 页都从 `window.MAG_CONFIG.DATA_URL`（默认同源 `/api/public/data`）拉 live 数据，**v5 起必须带 secret 鉴权**。数据是 real-time 的，admin 改完阅读端刷新立刻看到。

`public/config.js` 可改 `DATA_URL` 走 OSS / 跨域后端。

## 项目结构

```
magazine-admin/
├── server/
│   ├── index.js              # Express 双服务启动（公共 + 后台）
│   ├── public.js             # 公共阅读端 app + requireReaderAuth
│   ├── admin.js              # 后台 app
│   ├── auth.js               # session + requireAuth/requireRole/requirePlatformAdmin
│   ├── smtp.js               # nodemailer 包装（无 key 时 console.log + status pending）
│   └── db/
│       ├── data.json         # JSON 持久化（gitignore）
│       ├── init.js           # 数据操作 + audit_log + reader_secret helpers
│       ├── migrate-to-v2.js  # 历史迁移
│       ├── migrate-to-v3.js
│       └── migrate-to-v4.js
├── public/
│   ├── config.js             # window.MAG_CONFIG
│   ├── splash.html / directory.html
│   ├── reader/
│   │   ├── viewer.html
│   │   ├── secret.js         # v5: MAG_READER_AUTH helper
│   │   ├── track.js          # 阅读埋点
│   │   ├── lib/jquery.min.js / turn.min.js
│   │   └── images/
│   ├── images/ (logo, fallback)
│   ├── uploads/ (本地 fallback)
│   └── admin/
│       ├── login.html / index.html / signup-verify.html
│       ├── platform.html / audit.html / email-log.html
│       ├── tenant-users.html / billing.html / analytics.html
│       ├── branding.html     # v4 + v5 加「阅读端分享链接」卡
│       ├── magazine/ cover/
│       ├── css/style.css     # 共享样式（font 16, sidebar logo 64, nav-icon 20, Lucide）
│       └── js/
│           ├── api.js        # 后台 API 客户端
│           ├── auth.js       # MAG_AUTH.requireAuth + getTenant + getUser + getRole
│           ├── nav.js        # MAG_NAV 共享侧栏渲染器（10 项单一权威 + Lucide）
│           └── topbar.js     # MAG_TOPBAR 顶栏渲染器（侧栏富 logo + 顶栏 user info）
├── scripts/
│   └── start-50120.js        # Node 包装器（进程内 setenv + require server/index.js）
├── .env                      # OSS 凭证 + ADMIN_PASSWORD（gitignore）
├── .gitignore
├── package.json
└── SPEC.md
```

## 启动

```bash
cd magazine-admin
npm install
# 直接起
"C:\Program Files\nodejs\node.exe" scripts\start-50120.js
# 或用快捷启动
C:\Users\YKing\start-server-50120.bat
# 公共阅读端 http://localhost:50100
# 后台登录   http://localhost:50120/admin/login.html
```

`.env` 必备：
```
OSS_REGION=oss-cn-beijing
OSS_BUCKET=openclawbsf
OSS_PREFIX=magazine-admin/covers/
OSS_ACCESS_KEY_ID=...
OSS_ACCESS_KEY_SECRET=...
ADMIN_PASSWORD=MagAdmin2026ChangeMe
SMTP_HOST=smtp.example.com   # 可选；不配则 console.log + email_log status=pending
SMTP_PORT=465
SMTP_USER=...
SMTP_PASS=...
SMTP_FROM="杂志管理平台 <noreply@example.com>"
```

## 默认账号

- 平台管理员 tenant: `zhuobao`（slug），owner 邮箱 `admin@zhuobao.local`，密码 `ADMIN_PASSWORD` env 决定
- 新租户通过 `POST /api/public/signup` 自助注册（验证邮件 → 点链接 → 拿到初始密码 → 登录）
- 或由平台管理员在「平台管理 → 新建租户」创建

## 阅读端链接生成

admin 端 owner 在「品牌定制」页：
1. 看到「🔗 阅读端分享链接」卡
2. 复制完整 URL（含 `?t=slug&s=32字符base64url`）
3. 发给读者 / 群发给客户

link 格式：`http://<hostname>:50100/?t=<slug>&s=<secret>`

`regenerate` 按钮：弹 confirm → 调 `/api/admin/tenant/reader-secret/regenerate` → 旧 secret 立即失效（持有旧链接的人 401），新 secret 写入 data.json 持久化。

## 部署 Checklist

### 内网 / LAN（推荐起步）
1. 内网机器 `git pull && npm install`
2. `start-server-50120.bat` 双击起
3. 防火墙放行 `50100` + `50120`
4. admin 登录：浏览器打开 `http://<LAN-IP>:50120/admin/login.html`
5. 给 owner 生成阅读链接：品牌定制页 → 复制链接
6. 同事用阅读端：`http://<LAN-IP>:50100/?t=<slug>&s=<secret>`

### SaaS（公网）
1. 同机起 admin + public（50120 / 50100），对外暴露
2. DNS：`zhuobao.example.com` 等子域名 → 同一公网 IP（未来可加 per-tenant subdomain）
3. 反代 nginx 配 `Host` 头传给 Node
4. 平台管理员登录后建新租户、设置 owner 邮箱
5. 走自助注册或邀请流程让 owner 拿到初始密码
6. owner 登录后复制阅读链接，发给本租户读者

### 监控要点
- data.json 不要手工编辑 UTF-16 LE（之前出过 `loadData` 静默失败的坑）
- 内存 session 24h TTL，server 重启会清空（用户需重登）
- audit_log 限 10000 条，reader_analytics 限 50000 条，email_log 限 5000 条
- 平台管理员被删后不可恢复（强约束：不能删 platform admin tenant）

## 已废弃 / 不做（v3 切到 v4 明确砍掉）

- ❌ 租户级 password 登录（仍保留 fallback，但不再主推）
- ❌ publish 桥（OSS 缓存 + CDN）—— 阅读端直接走 live `/api/public/data`
- ❌ per-tenant subdomain（暂用 `?t=slug` URL 模式；半年后规模上来再迁）
- ❌ 配额 / 用量限制（v2 计划里砍掉）
- ❌ per-tenant API key
- ❌ webhooks

## 已知限制

- password hash 仍是 SHA-256 + 静态 salt，生产应换 bcrypt
- session 在内存，水平扩展需要外置 Redis
- 公共端无 rate limit（防爬靠 secret 自然隔离）
- 跨租户读唯一通过 secret，没加 per-tenant 域名级隔离

## 最近一次 schema 迁移

- v4 → v5（`server/db/init.js` 升 `_meta.schema_version` 5 + `loadData` 自动 backfill reader_secret）
- 老租户缺 `reader_secret` → 自动生成 32 字符 base64url + 立即持久化
- 已跑过，无需人工迁移

---

## v6.0 增量 — AI 一句话生成画册骨架

### 范围

**做**：owner 在后台输入一句中文描述（1–2000 字），后端调 MiniMax M3 生成结构化画册骨架（页标题 + 100–300 字正稿），写入 data.json 作为一条新 magazine（`enabled=0`，待用户后续手动配图 + 发布）。

**不做**（明确砍掉）：
- ❌ AI 选模板（模板中心是 v6.2 路线）
- ❌ AI 配图 / 文生图（本期只产 text 骨架，不带图）
- ❌ AI 编辑已有杂志（无 `PATCH /ai/edit`）
- ❌ AI 翻译（locale 仅作为 prompt 提示词，不真正切换输出语言风格以外的产物）
- ❌ 限速（每租户 N 次/天）—— 本期未做，v6.1 加

### MiniMax M3 接入规范

**环境变量**：
```
MINIMAX_API_KEY=<32+ 字符>          # 必填；缺失时 500 + 明确错误
MINIMAX_BASE_URL=https://api.minimax.chat/v1   # 默认；可指向 mock / proxy
MINIMAX_MODEL=MiniMax-M3             # 默认；本期锁死 M3，不做模型选择 UI
```

**调用封装**：`server/ai-client.js` 导出 `generateMagazineSkeleton({ title, prompt, pageCount, locale })`。

**System Prompt 强约束 JSON Schema**（通过 system prompt + response_format=json_object 双约束）：
```json
{
  "name": "string, ≤ 80 字，画册标题",
  "description": "string, ≤ 200 字，一行描述",
  "pages": [
    { "page_order": 1, "title": "string, ≤ 30 字", "body": "string, 100–300 字 markdown 风格正稿" }
  ]
}
```

`pages.length` 必须等于 `pageCount`；任意字段缺失 / 类型错 → 抛 `AiParseError`。

**Retry 策略**：退避重试 5s → 15s → 30s，最多 3 次；触发重试的场景：
- HTTP 5xx（502/503/504/529）
- HTTP 429（rate limit）
- JSON parse 失败（视为 LLM 输出漂移，重试可能拿到合规结果）
- 网络超时（fetch 30s）

非 5xx / 非 429 的 4xx（除 408）→ 立即抛错，不重试。

**Logging**：调用开始 `console.log('[ai] start model=… prompt_chars=…')`；结束 `console.log('[ai] ok duration_ms=… retries=…')`；重试 `console.warn('[ai] retry N reason=…')`；失败 `console.error('[ai] fail err=…')`。**严禁 log `MINIMAX_API_KEY` 或 Authorization header**。

### 新增端点：`POST /api/admin/ai/skeleton`

**Auth**：`auth.requireRole('owner')`（editor / viewer 拒绝 403；未登录 401）。

**Request Body**（JSON，Content-Type: application/json）：
```json
{
  "prompt": "string, 5–2000 字, 必填",
  "title": "string, ≤ 80 字, 可选, 覆盖 LLM 自动生成的 name",
  "pageCount": "integer, 3–20, default 6",
  "locale": "string, 'zh-CN' | 'en-US', default 'zh-CN'"
}
```

**200 OK**：
```json
{
  "magazine": { "id": 123, "name": "...", "description": "...", "enabled": 0, "tenant_id": 1, "upload_date": "2026-06-12", "cover_pc": "", "cover_mobile": "" },
  "pages": [
    { "id": 456, "page_order": 1, "image_path": "", "title": "...", "body": "...", "is_skeleton": true }
  ],
  "llm_meta": { "model": "MiniMax-M3", "duration_ms": 4321, "retries": 0 }
}
```

**4xx**：
- `400`：`prompt` 缺失 / 长度越界 / `pageCount` 越界 / `locale` 不在白名单
- `401`：未登录
- `403`：当前角色不是 owner
- `404`：tenant 不存在（理论上不会发生，防御性写）

**5xx**：
- `500 MINIMAX_API_KEY not configured`（环境变量缺失）
- `500 AI_UPSTREAM_ERROR`（LLM 4xx 非重试错；message 透传但不暴露原始 stack）
- `500 AI_PARSE_ERROR`（3 次重试后仍 JSON parse 失败）
- `502 AI_UPSTREAM_TIMEOUT`（30s fetch 超时）
- `503 AI_UPSTREAM_5XX`（重试 3 次后仍 5xx）

> **数据完整性**：LLM 调用成功但落库失败时，已 `createMagazine` 的记录必须删除（避免孤立空壳）。当前实现顺序为 `createMagazine → addPages`，任一步异常即回滚上一条 magazine。

### pages schema 扩展（schema v5 → v6）

**新增字段**（`server/db/init.js` `requiredArrays.pages` 兼容扩展）：
| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `title` | TEXT | `''` | 页标题（LLM 生成；空字符串兼容 v5 老数据） |
| `body` | TEXT | `''` | 页正稿 markdown 文本（LLM 生成） |
| `is_skeleton` | BOOLEAN | `false` | true = AI 骨架页（用户后续可手动上传图替换） |

**`_meta.schema_version`**：5 → **6**。`loadData()` 在 `schema_version < 6` 时对 `pages` 数组 forEach 补默认值（`title ??= ''`、`body ??= ''`、`is_skeleton ??= false`），不破坏既有 v5 magazine。

**Magazine 字段**：本期不动 magazine 既有字段。新建 magazine 时 `enabled` 强制写 0（schema 默认 1，调用层覆盖）；用户后续上传封面 + 改 enabled 后才在公共端可见。

### 新增前端页：`public/admin/ai-generate.html`

**位置**：admin 后台独立页，不嵌入既有 iframe。

**5 个字段**（form 形态）：
1. `<textarea name="prompt" required minlength=5 maxlength=2000>` —— 主输入，必填
2. `<input name="title" maxlength=80>` —— 可选，覆盖标题
3. `<input name="pageCount" type=number min=3 max=20 value=6>` —— 3–20 页，默认 6
4. `<select name="locale">` —— `zh-CN`（默认）/ `en-US`
5. 提交按钮 —— 「✨ 生成骨架」

**提交流程**：
```
[提交] → 禁用按钮 + spinner
       → api.aiSkeleton({ prompt, title, pageCount, locale })
       → 200：渲染 #skeletonOutput（JSON 美化 + pages 列表卡片化）
            + toast 成功
            + 「应用到杂志列表」按钮亮起
       → 401：跳 /admin/login.html
       → 403：toast「仅 owner 可用」
       → 4xx/5xx：form 上方红条 + toast 错误（err.message）
```

**跳转高亮**：成功按钮 `onclick = location.href = '/admin/magazine/list.html?highlight=<magazine.id>'`，list.html 检测 `?highlight=` 参数，对应行加 `.row-highlight` CSS class（3s 黄底淡出）。

**XSS 防护**：LLM 返回的 title / body 渲染**必须**用 `textContent` 或 `Node.textContent = ...`，禁止 `.innerHTML = userInput` / `.innerHTML = llmBody`。不引入 marked / DOMPurify 依赖（保持 zero new deps）。

**入口**：sidebar 在「杂志管理」上方加「✨ AI 一句话生成」链接，href=`/admin/ai-generate.html`，Lucide 图标沿用 `sparkles`。

**API 客户端**：`public/admin/js/api.js` 末尾追加：
```js
api.aiSkeleton = ({ prompt, title, pageCount, locale }) =>
  api.post('/api/admin/ai/skeleton', { prompt, title, pageCount, locale });
```

### 审计

每次成功 / 失败 LLM 调用都写 `audit_log`：
- 成功：`action='ai_generate_skeleton'`、`target_type='magazine'`、`target_id=<new_id>`、`details={ page_count, prompt_chars, llm_model, duration_ms, retries }`
- 失败：`action='ai_generate_skeleton_failed'`、`details={ reason, http_status, retries }`（写 audit 但不暴露 prompt 全文，仅 `prompt_chars`）

平台管理员可在 `/admin/audit.html` 看到全部 AI 调用记录（action 筛选新增 `ai_generate_skeleton` / `ai_generate_skeleton_failed` 两个值）。

### 限速

**本期未做**。每次调用都会真实打 MiniMax API，恶意 owner 可刷量产生费用。

**v6.1 建议方案**：
- 每租户 `N=50` 次/天（默认），平台管理员可调
- 实现位置：`server/admin.js` 端点入口加 `aiRateLimit(req.tenant.id, 'skeleton')`
- 持久化：data.json 加 `_rate_limit` 表（`{ tenant_id, action, date, count }`），每天 UTC+8 0 点 reset
- 429 响应：`{ error: 'AI_RATE_LIMIT', retry_after_hours: <剩余小时> }`

### 失败模式

| 场景 | 行为 | 状态码 |
|------|------|--------|
| `MINIMAX_API_KEY` 未设 | 端点直接 500 + 明确错误 | 500 |
| MiniMax 5xx | 退避重试 5s/15s/30s，3 次仍失败 → 5xx 抛回 | 503 |
| MiniMax 429 | 同 5xx 退避重试 | 503 |
| MiniMax 4xx（非 408） | 立即抛错，不重试 | 500 AI_UPSTREAM_ERROR |
| 网络 30s 超时 | 单次超时 → 重试；3 次超时 → 502 | 502 |
| JSON parse 失败 | 重试；3 次仍失败 → 500 | 500 AI_PARSE_ERROR |
| `pages.length !== pageCount` | 视为 parse 错，重试 | 500 AI_PARSE_ERROR |
| LLM 成功但 `addPages` 失败 | 回滚已建的 magazine（deleteMagazine） | 500 |
| 租户被 suspend | 401 | 401 |

### 非目标（v6.0 明确不做）

- ❌ AI 选模板 / 模板中心（v6.2 路线）
- ❌ AI 配图 / 文生图（依赖图片生成模型，成本 & 合规需评估）
- ❌ AI 翻译（locale 仅作为 prompt hint，不真正切换输出语言风格以外的产物）
- ❌ AI 改稿 / 编辑已有杂志（无 `PATCH /api/admin/ai/edit`，用户手动改）
- ❌ 限速（v6.1 才做）
- ❌ AI 审计大屏（v6.2 候选；本期 audit 页 action 筛选已支持，但无独立 AI 看板）
- ❌ 多模型路由（锁死 MiniMax-M3）
- ❌ 流式输出（SSE / stream）—— 本期 wait-then-return，UI 用 spinner

---

## v6.1 增量 — AI 限速 + 审计大屏

### 范围

**做**：
- 1️⃣ 每租户每日硬上限的 AI 调用限速：避免 owner 刷量产生 MiniMax API 费用
- 2️⃣ 超限返回标准 429 + 响应头，方便前端展示
- 3️⃣ 限速命中独立写 `audit_log`（`action='ai_rate_limited'`），大屏可单独计数
- 4️⃣ AI 调用大屏（独立 admin 页）：4 卡片 + 7 日 SVG 柱状图 + 失败 top 5 + 今日剩余配额

**不做**（明确砍掉，留 v6.2+）：
- ❌ 跨租户 benchmark / 平台侧 AI 总量看板
- ❌ 计费集成（按 AI 调用量额外扣费）
- ❌ Grafana / Prometheus 接入
- ❌ 限速策略可配置 UI（仅 env 覆盖，不做租户级面板）
- ❌ 失败 audit 改造（v6.0 失败分支不写 audit，failed 计数恒为 0，大屏按空态展示）

### 限速策略

| 配置 | 值 | 说明 |
|------|-----|------|
| 默认上限 | **20 次/租户/24h** | `AI_DAILY_LIMIT` env 可覆盖；env 缺失 / 非整数 / ≤ 0 → fallback 20 |
| 窗口 | 24h（UTC 对齐） | `AI_DAILY_WINDOW_MS = 24*60*60*1000`；桶 `key = floor(now/windowMs)`，同一桶内累计 |
| 存储 | 内存 `Map<key, { count, resetAt }>` | **纯 Node.js Map，无外部依赖**；进程重启清空（v6.1 接受，不强求持久化） |
| 清理 | `setInterval` 每 60s 扫一次过期 entry | `unref()` 不阻塞进程退出；`store.size > 1024` 时在高频路径顺手扫一次 |
| 限速通过 | 自增 1，写 `audit_log action='ai_generate_skeleton' details.rate_remaining` | 大屏可直接 sum 求「今日剩余趋势」 |
| 限速拒绝 | **不**消耗配额（不 increment），写 `audit_log action='ai_rate_limited'` | `current` 字段保持 `limit`，返回 `allowed=false` |

**实现位置**：`server/rate-limit.js`（新文件，**独立模块便于单测**）。

### 端点

#### `POST /api/admin/ai/skeleton`（v6.0 端点，v6.1 加限速）

- **行为**（在调 `aiClient.generateMagazineSkeleton` **之前**插限速）：
  ```
  checkAndIncrement(tenant.id, 'ai_skeleton', AI_DAILY_LIMIT, AI_DAILY_WINDOW_MS)
    → { allowed, current, limit, resetAt }
  ```
- **限速通过**：照常走 LLM 调用，audit 写 `ai_generate_skeleton`，`details.rate_remaining = limit - current`
- **限速拒绝**：直接 429 + 写 `audit_log action='ai_rate_limited'`
- **mock 模式**（`MOCK_AI=1`）：**也走限速**（同配额），保证真实场景和开发场景一致

#### `GET /api/admin/ai-stats?since=ISO`（v6.1 新增）

- **Auth**：`auth.requireAuth`（**owner / editor 都能看**，不限制 owner-only；audit 页已经是同样口径）
- **`since` 默认**：7 天前（`now - 7*24*3600*1000`）
- **返回**：
  ```json
  {
    "summary": {
      "total": 42,                  // ai_generate_skeleton 总数
      "success": 38,                // 成功（details.error 空）
      "failed": 0,                  // 失败（details.error 非空；v6.0 失败分支不写 audit，恒为 0 → UI 空态）
      "rate_limited": 4,            // ai_rate_limited 命中
      "avg_duration_ms": 1240,
      "p95_duration_ms": 2100
    },
    "trend": [
      { "bucket": "2026-06-06T00:00:00.000Z", "total": 5, "success": 5, "failed": 0, "rate_limited": 0 },
      ...   // 7 个桶，按 UTC 零点对齐
    ],
    "top_failures": [
      { "error": "AI_UPSTREAM_TIMEOUT", "count": 3 }
    ],
    "quota": {                     // 顶卡用：今日剩余配额
      "current": 12,                // 今日已用
      "limit": 20,
      "resetAt": "2026-06-13T00:00:00.000Z"
    }
  }
  ```
- **p95 算法**：`sort` 后取 `Math.floor(n*0.95)` 位置；`n<1` 回退 0；不引外部库
- **trend 桶补齐**：`since..until` 之间缺数据的桶也返回（total=0），UI 折线/柱状不出现空洞

#### `GET /api/admin/ai-quota`（v6.1 新增，**轻量**配额查询）

- **Auth**：`auth.requireAuth`
- **返回**：`{ current, limit, resetAt }`（不 increment，只 peek）
- **实现**：`rateLimit.peek(tenantId, 'ai_skeleton', AI_DAILY_LIMIT, AI_DAILY_WINDOW_MS)`
- **用途**：UI 在调用 `ai/skeleton` 之前就能预判「还剩 N 次」，避免用户填完 2000 字 prompt 提交后才看到 429

### 429 响应

```json
{
  "error": "已达今日 AI 生成上限（20 次），明天 0 点重置",
  "current": 20,
  "limit": 20,
  "resetAt": "2026-06-13T00:00:00.000Z"
}
```

- 状态码：`429 Too Many Requests`
- `Content-Type: application/json; charset=utf-8`
- 消息友好：明确告诉用户是「今日」超限 + 重置时间（明天 0 点）

### 响应头（v6.0 端点 + v6.1 配额端点都加）

| Header | 说明 | 示例 |
|--------|------|------|
| `X-RateLimit-Limit` | 窗口内总配额 | `20` |
| `X-RateLimit-Remaining` | 剩余次数 | `15` |
| `X-RateLimit-Reset` | 桶重置时间（ISO 8601） | `2026-06-13T00:00:00.000Z` |

- **每次调用都带**（无论通过 / 拒绝）
- 前端可直接读 3 个 header，无需额外请求配额端点

### 审计大屏端点

见上文 `GET /api/admin/ai-stats`。**额外** `audit_log` 写入约定：

| 场景 | action | details 关键字段 |
|------|--------|------------------|
| 限速通过 + LLM 成功 | `ai_generate_skeleton` | `page_count`, `prompt_chars`, `model`, `mock`, `duration_ms`, `retries`, `rate_remaining` |
| 限速拒绝 | `ai_rate_limited` | `action_blocked: 'ai_skeleton'`, `limit`, `current`, `reset_at`, `prompt_chars` |
| 限速通过 + LLM 失败 | `ai_generate_skeleton`（details.error 写入） | 额外 `error: 'AI_UPSTREAM_TIMEOUT'` 等 |

> **v6.1 遗留**：v6.0 失败分支**不**写 audit（admin.js:518 LLM 异常 → 直接 return 500）。v6.1 大屏 `failed` 计数因此恒为 0，对应空态；后续可在 v6.2 给失败分支补 `auth.audit(req, 'ai_generate_skeleton', { ..., details: { ..., error: e.message } })`。

### 大屏 UI（`public/admin/ai-stats.html`）

- **入口**：sidebar 在「AI 一句话生成」下方加「📊 AI 调用大屏」链接，Lucide 图标 `bar-chart-3`，href=`/admin/ai-stats.html`
- **顶部 4 个大数字卡片**（grid layout，2×2 桌面 / 1×4 移动）：
  1. **今日调用**（蓝色）— `summary.total`（包含 rate_limited）
  2. **成功**（绿色）— `summary.success`
  3. **失败**（红色，空态显示「—」）— `summary.failed`
  4. **限速命中**（橙色）— `summary.rate_limited`
- **顶部第 5 卡片**（横跨整行，高亮）：**「今日剩余配额：N / 20」**（调 `ai-quota` 端点；调用 `ai/skeleton` 后立即刷新）
- **中部**：近 7 天 SVG 柱状图（**纯 SVG，不用 chart 库**；每个柱 = `summary.trend[i].total`；高度 = `count / maxCount * 200px`；hover 显示 tooltip 数字 + 时间）
- **底部**：失败 top 5 表格（`top_failures`：列 = error 消息 / 次数；空态显示「暂无失败记录」）
- **空态**：audit_log 无 ai_* 条目时，4 卡片显示「—」，柱状图显示「暂无数据」占位
- **错误态**：拉数据失败（401/500）时顶部红条提示「数据加载失败：<err.message>」+ 重试按钮
- **复用**：`nav.js` / `topbar.js` / `admin.css`（与 `ai-generate.html` 风格一致）
- **XSS 防护**：`textContent` 渲染后端数据，禁止 `.innerHTML = userInput`
- **零新依赖**（与 v6.0 一致：保持 zero new deps）

### 数据来源

**全部从 `audit_log` 表过滤 + 聚合**，不引入新表：

```
action IN ('ai_generate_skeleton', 'ai_rate_limited')
  AND (since 过滤)
  AND (tenant_id 隔离)
```

- `getAiCallStats({ tenantId, since, until })` → `{ total, success, failed, rate_limited, avg_duration_ms, p95_duration_ms }`
- `getAiCallTrend({ tenantId, since, until, bucketMs })` → `[{ bucket, total, success, failed, rate_limited }]`
- `getAiCallTopFailures({ tenantId, since, until, limit })` → `[{ error, count }]`
- 三个函数**纯聚合** + **p95 简易算法**（sort + floor 0.95），不引外部库
- 位置：`server/db/init.js` 末尾追加，module.exports 一并导出

### Env 变量

| 变量 | 默认 | 范围 | 说明 |
|------|------|------|------|
| `AI_DAILY_LIMIT` | `20` | `1..∞` 整数 | 每租户每日 AI 调用上限；env 缺失 / 非整数 / ≤ 0 → fallback 20 |
| `MOCK_AI` | `0` | `0` / `1` | mock 模式开关（v6.0 沿用）；mock 模式也走限速（同配额） |

### 非目标（v6.1 明确不做）

- ❌ **跨租户 benchmark / 平台侧 AI 总量看板**（v6.2 候选）
- ❌ **计费集成**（按 AI 调用量额外扣费；v6.2+ 路线）
- ❌ **Grafana / Prometheus 接入**（v6.2 候选）
- ❌ **限速策略可配置 UI**（仅 env 覆盖；v6.2 候选）
- ❌ **失败 audit 改造**（v6.0 失败分支不写 audit；v6.1 failed 计数恒为 0，对应空态展示）
- ❌ **限速持久化**（进程重启清空；接受；如需重启保留可 v6.2 改 data.json 表）
- ❌ **滑动窗口**（v6.1 是固定窗口；v6.2+ 可改 sliding window）
- ❌ **多动作统一限速**（本期只限 `ai_skeleton`；`ai_edit` 等未来动作单独配置）

### v6.2 候选（来自 v6.0/v6.1 范围遗留 + 业务演进）

1. 跨租户 AI 调用 benchmark（平台管理员视角）
2. 计费集成（超出 plan 配额按调用量额外扣费）
3. Grafana / Prometheus 接入（监控 + 告警）
4. 限速策略可配置 UI（platform admin 调各租户 quota）
5. 失败 audit 改造（v6.0 失败分支补 audit，让大屏 `failed` 不再恒为 0）
6. 限速持久化到 data.json（重启不丢）
7. 滑动窗口限速（sliding window，行为更平滑）
8. 模板中心 / AI 选模板（v6.0 砍掉）
9. AI 配图 / 文生图（成本 + 合规评估中）
10. AI 改稿 / 编辑已有杂志
11. 多模型路由（v6.0 锁死 MiniMax-M3；v6.2 拆 client 抽象层）

---

## v6.2 增量 — PDF 智能解析 → 自动建画册

### 范围

**做**：
- owner 在后台拖拽 / 选择 PDF → 后端自动抽每页转 PNG → 调 LLM 给每页写标题 + 简介 → 落库为草稿 magazine（`enabled=0`，待用户后续手动配图调整）
- 落地后的图存本地 `uploads/skeleton/<id>/page-N.png`（**草稿不上 OSS**）
- 仍受 v6.1 AI 限速约束（每租户 20 次/天，PDF 调用算 1 次/天）
- 复用 v6.0 端点 `POST /api/admin/ai/skeleton` 的部分基础设施（限速 / 审计 / mock）

**不做**（明确砍掉，留 v6.3+）：
- ❌ OSS 上传 / 草稿直接上云（草稿不上云，保持本地化快速迭代）
- ❌ 多租户共享 PDF（PDF 仅限本租户 owner 上传，不进平台级 PDF 库）
- ❌ OCR 文字层（PDF → 图 → LLM 视觉理解，**不**走 OCR 文本抽取；v6.3+ 评估）
- ❌ PDF 模板中心 / PDF 风格选择（v6.0 砍掉的 AI 选模板路线，PDF 版暂不做）
- ❌ 加密 PDF 自动破解（检测到加密 → 直接报错，**不**尝试爆破）
- ❌ 实时流式进度（前端 XHR onprogress 只能看到 upload 阶段；AI 解析阶段黑盒，等到 200 后才看到结果）

### 依赖

| 包 | 用途 | 为什么选它 |
|----|------|----------|
| `pdf-img-convert` | PDF → PNG buffer（纯 JS） | 免装 ghostscript；Windows 直接 `npm install` 装上；输出 PNG buffer 不用中间落盘 |
| `multer`（已有） | 接收 `multipart/form-data` 的 PDF 文件 | 已有 v4 文件上传链路 |

**明确不引**：
- ❌ `pdf2pic`：要 ghostscript，Windows 装 chain 痛苦
- ❌ `pdfjs-dist`：要 node-canvas，太重；纯 Node 后端不需要把 PDF 渲染到 canvas

**npm install 失败降级**：如果 `pdf-img-convert` 安装失败，README 注明手动步骤 + 端点允许 `pdf_pages=0`（用户后续手动上传图），**不**让端点整体 503。

### 新端点：`POST /api/admin/magazines/import-pdf`

**Auth**：`auth.requireRole('owner')`（editor / viewer 拒绝 403；未登录 401）。

**Request**：`multipart/form-data`，单一字段 `pdf`：
- Content-Type: `application/pdf` 或 `application/octet-stream`
- 大小上限：50 MB（multer limits）
- 文件名：原样保留到 `image_path` 元数据（不直接拼 URL，**不**做 OSS 上传）

**后端处理流程**：
```
1. multer 接收 PDF → req.file.buffer
2. 调 pdf-parser.parsePdfToPages({ buffer, maxPages: PDF_MAX_PAGES })
   → [{ index, imageBuffer, mime }]   // 截断到 30 页（PDF_MAX_PAGES 默认 30）
3. 本地落图：mkdir -p uploads/skeleton/<newId>/
            writeFileSync(page-N.png, imageBuffer)
4. 限速检查：rateLimit.checkAndIncrement(tenant.id, 'ai_skeleton', ...)
   → 失败 → 429 + 写 audit ai_rate_limited
5. 调 aiClient.analyzePdfPages({ pdfPages: [{ image_path, page_index }], locale })
   → LLM 看图给每页写 title + body
   → 复用 v6.0 mock（process.env.MOCK_AI=1）路径
6. createMagazine(enabled=0) + addPages(每个 page 带 title/body + 本地图路径)
7. 写 audit_log action='ai_pdf_import' details.pdf_pages_count=N
8. 返回 { magazine, pages }，结构同 v6.0
```

**200 OK**：
```json
{
  "magazine": { "id": 124, "name": "...", "description": "...", "enabled": 0, "tenant_id": 1, "upload_date": "2026-06-12", "cover_pc": "", "cover_mobile": "" },
  "pages": [
    { "id": 457, "page_order": 1, "image_path": "uploads/skeleton/124/page-1.png", "title": "...", "body": "...", "is_skeleton": true }
  ],
  "llm_meta": { "model": "MiniMax-M3", "duration_ms": 4321, "retries": 0, "pdf_pages_count": 8 }
}
```

**4xx / 5xx**：
- `400`：非 PDF 文件 / 文件大小超 50MB
- `401`：未登录
- `403`：当前角色不是 owner
- `429`：限速命中（v6.1 标准 429 body + 响应头）
- `500 MINIMAX_API_KEY not configured`：env 缺失（同 v6.0）
- `500 PDF_PARSE_ERROR`：加密 PDF / 解析异常
- `500 PDF_TOO_MANY_PAGES`：超 maxPages 截断（实际是静默截断 + 在 audit 标 `truncated: true`）
- `500 AI_PARSE_ERROR`：LLM 3 次重试后仍 JSON 解析失败
- `500 AI_UPSTREAM_ERROR` / `AI_UPSTREAM_TIMEOUT` / `AI_UPSTREAM_5XX`：同 v6.0

### 服务端模块：`server/pdf-parser.js`

**导出**：
```js
async function parsePdfToPages({ buffer, maxPages = 30 }) → [{ index, imageBuffer, mime }]
async function writePdfPagesToDisk({ pages, targetDir }) → [{ index, imagePath, filename }]
```

**实现要点**：
```js
const { convert } = require('pdf-img-convert');
const pngPages = await convert(buffer, { width: 1200 });  // 输出 array of Buffer
return pngPages.slice(0, maxPages).map((buf, i) => ({
  index: i + 1,
  imageBuffer: buf,
  mime: 'image/png'
}));
```

**失败检测**（在调 `convert` 之前先做防御）：
- `buffer.slice(0, 5).toString('ascii')` 不以 `%PDF-` 开头 → 抛 `PDF_PARSE_ERROR`
- `convert` 抛 `password required` / `encrypted` → 抛 `PDF_PARSE_ERROR: ENCRYPTED`
- 解析出 0 页 → 抛 `PDF_PARSE_ERROR: EMPTY`

### 复用：`server/ai-client.js` 新增 `analyzePdfPages`

**不**改 v6.0 `generateMagazineSkeleton`（避免 breaking change）。新增独立函数：

```js
async function analyzePdfPages({ pdfPages, locale }) → {
  pages: [{ page_order, title, body }],
  _meta: { model, duration_ms, retries, mock }
}
```

**System Prompt 强约束**：
```
你是资深画册编辑，**只看图说话**，严格按以下 JSON 结构输出：
{
  "pages": [
    { "page_order": 1, "title": "5-20 字页标题", "body": "100-300 字正稿" },
    ...
  ]
}
约束：
1) pages 长度必须等于输入 pdfPages.length
2) 严格按 page_index 升序输出
3) 不得编造图中没有的信息
4) 不输出 JSON 之外任何字符
```

**Mock 模式**（`MOCK_AI=1`）：返回固定 `pages` 数组（每页 title=`第 N 页（PDF MOCK）`、body=占位正稿），跟 v6.0 mock 一致。

**Retry 策略**：同 v6.0（5s / 15s / 30s 退避，最多 3 次）。JSON 校验失败 → 抛 `AI_PARSE_ERROR`。

### 落库与本地存储

**目录约定**：
```
uploads/
└── skeleton/
    └── <magazine-id>/
        ├── page-1.png
        ├── page-2.png
        └── ...
```

**`pages` 表 schema 不变**（v6 schema）：`image_path` 字段存相对路径 `uploads/skeleton/<id>/page-N.png`（同 v6.0 v5 既有约定，**不**用 OSS URL）。

**`.gitignore` 更新**：
```
uploads/skeleton/
```
（草稿页不上 git，避免二进制污染）

**前端访问**：admin 端用 `/uploads/skeleton/<id>/page-N.png` 走 express static 暴露（`public/uploads` 已挂载，`uploads/` 也在 `server/index.js` 静态目录）。

### 限速

**复用 v6.1 限速器**：`rateLimit.checkAndIncrement(tenant.id, 'ai_skeleton', AI_DAILY_LIMIT, AI_DAILY_WINDOW_MS)`。

- PDF 调用 **算 1 次/天**（不单独算，按 `ai_skeleton` 同桶）
- 429 响应 + 响应头同 v6.1
- 限速拒绝时**不**消耗配额；通过路径 audit `details.pdf_pages_count` 字段标识 PDF 路径

### 审计

每次成功 / 失败 PDF 导入都写 `audit_log`：

| 场景 | action | details 关键字段 |
|------|--------|------------------|
| 限速通过 + LLM 成功 | `ai_pdf_import` | `pdf_pages_count`, `prompt_chars`（固定 0，无 prompt）, `model`, `mock`, `duration_ms`, `retries`, `rate_remaining`, `truncated`（bool） |
| 限速拒绝 | `ai_rate_limited` | 同 v6.1，附加 `action_blocked: 'ai_pdf_import'` |
| 限速通过 + LLM 失败 | `ai_pdf_import`（details.error 写入） | 额外 `error: 'AI_PARSE_ERROR'` 等 |
| PDF 解析失败 | `ai_pdf_import_failed` | `reason: 'PDF_PARSE_ERROR'`, `error: 'ENCRYPTED'` 等 |
| 限速通过 + `addPages` 失败 | `ai_pdf_import`（回滚 magazine） | 额外 `rolled_back: true` |

> **v6.1 遗留**：`ai_pdf_import_failed` 是 v6.2 新增的失败 audit，让大屏能统计 PDF 解析失败。但 v6.0 失败分支不补 audit（v6.1 接受）。大屏的 `failed` 计数仍可能 0 → UI 空态。

### 前端页：`public/admin/ai-pdf.html`

**位置**：admin 后台独立页（**不**嵌入既有 iframe）。

**4 段布局**：
1. **拖拽区**（顶部）：`<div class="drop-zone" accept=".pdf">` 监听 `dragenter` / `dragover` / `drop`；drop 时 accept 检查（不是 PDF → 提示错误）；显示文件名 + 大小
2. **进度条**（中部）：调用 `api.aiPdfImport(file, onProgress)` 期间
   - "上传中… {percent}%"（XHR `upload.onprogress`）
   - "AI 解析中…"（后端 PDF 解析 + LLM 阶段，前端黑盒）
   - 错误条（401/403/400/500 区分提示）
3. **骨架预览**（解析完成后）：同 `ai-generate.html` 模式（4 数字卡 + 页列表）
4. **落库跳转按钮**（底部）：「应用到杂志列表」→ 跳 `/admin/magazine/list.html?highlight=<id>`

**XSS 防护**：PDF 文件名、LLM 返回 title/body 一律 `textContent` 渲染，禁止 `.innerHTML = userInput`（同 v6.0）。

**API 客户端**（`public/admin/js/api.js` 末尾追加）：
```js
api.aiPdfImport = (file, onProgress) => {
  // 用 XHR 不用 fetch（fetch 不支持 onprogress）
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    form.append('pdf', file);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round(e.loaded / e.total * 100));
    };
    xhr.onload = () => { /* 200/4xx/5xx 处理，透传 err.message */ };
    xhr.onerror = () => reject(new Error('网络错误'));
    xhr.open('POST', '/api/admin/magazines/import-pdf', true);
    xhr.send(form);
  });
};
```

**nav.js 入口**：在 `ai-generate` 后插入 `ai-pdf` 项（key=`ai-pdf`，label=「📄 AI PDF 一键生成」，icon=`file-text`，role=`owner`）。

### 失败模式

| 场景 | 行为 | 状态码 |
|------|------|--------|
| `MINIMAX_API_KEY` 未设 | 端点直接 500 + 明确错误 | 500 |
| 非 PDF 文件（magic bytes 不对） | 拒绝 + 明确错误 | 400 |
| 加密 PDF | 抛 `PDF_PARSE_ERROR: ENCRYPTED` | 500 |
| 0 页 PDF | 抛 `PDF_PARSE_ERROR: EMPTY` | 500 |
| PDF > 30 页 | **静默截断**到 30 页 + audit `truncated: true`（不报错） | 200 |
| PDF 50MB+ | multer 拦截 | 400 |
| `pdf-img-convert` npm 装失败 | 端点 503 + 降级路径提示前端「请改用 AI 一句话生成」 | 503 |
| MiniMax 5xx | 退避重试 5s/15s/30s，3 次仍失败 | 503 |
| JSON parse 失败 | 退避重试，3 次仍失败 | 500 AI_PARSE_ERROR |
| LLM 成功但 `addPages` 失败 | 回滚已建的 magazine（deleteMagazine） | 500 |
| 限速命中 | 429 + 写 `audit_log ai_rate_limited` | 429 |
| `req.file` 为空（用户没传文件） | 400 | 400 |

### Env 变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `PDF_MAX_PAGES` | `30` | PDF 解析最大页数（env 缺失 / 非整数 / ≤ 0 → fallback 30） |
| `MOCK_AI` | `0` | 复用 v6.0 mock 开关；mock 模式也走限速（同配额） |
| `AI_DAILY_LIMIT` | `20` | 复用 v6.1 限速上限（PDF 调用算 1 次/天） |

### 非目标（v6.2 明确不做）

- ❌ **OSS 上传**（草稿不上云，保持本地 `uploads/skeleton/`）
- ❌ **多租户共享 PDF**（每租户 owner 仅管自己上传的 PDF）
- ❌ **OCR 文字层**（v6.3+ 评估；本期纯视觉理解）
- ❌ **PDF 模板中心**（v6.0 砍掉的 AI 选模板路线，PDF 版暂不做）
- ❌ **加密 PDF 自动破解**（检测到加密 → 直接报错，不尝试爆破）
- ❌ **PDF 二次编辑**（生成后用户只能改 title/body，图不能换；v6.3+ 考虑加"重新生成第 N 页"）
- ❌ **跨页内容引用**（LLM 不被允许跨页拼接信息；只看单页图说话）
- ❌ **PDF 实时预览**（上传前不显示 PDF 首页缩略图，v6.3+ 可加 `pdf.js` 客户端预览）

### v6.3 候选

1. **OCR 文字层**：PDF → 文字层抽取 + LLM 视觉理解双轨合并，文字稿可被搜索 / 复制
2. **PDF 客户端预览**：上传前用 `pdf.js` 显示首页缩略图，减少误传
3. **跨页内容引用**：LLM 可参考前后页内容生成连续叙述
4. **PDF 二次编辑**：单页重新生成（"重写第 3 页"），不必整本重来
5. **OSS 上传**：草稿 → 发布后自动同步到 OSS，公共阅读端走 OSS CDN
6. **PDF 模板中心**：用户选模板（"杂志风 / 简洁风 / 学术风"），影响 LLM 输出风格
7. **失败 audit 改造（v6.1 遗留）**：v6.0 失败分支补 audit，让大屏 `failed` 不再恒为 0
8. **限速持久化到 data.json**（v6.1 遗留）：进程重启不丢配额
9. **滑动窗口限速**（v6.1 遗留）：sliding window 行为更平滑
10. **多模型路由**（v6.0 遗留）：拆 `ai-client` 抽象层，支持 Claude / GPT-4 切换
11. **跨租户 AI benchmark**（v6.1 遗留）：平台管理员视角看各租户 AI 用量

---



