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
