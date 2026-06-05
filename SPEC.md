# 杂志管理平台 - Magazine Admin CMS

## 概念与愿景

多租户 SaaS 杂志管理平台。**平台管理员**统一管租户和看审计；**租户**各自登录后台管自己的杂志和封面；**公共阅读端**让任何访客按租户 slug 切到对应杂志。schema v3（多租户 + 平台管理员 + 审计日志 + 暂停机制）。

## 技术栈

- **后端**: Express.js + JSON 文件存储（schema v3）
- **前端**: 原生 HTML/CSS/JS，无框架依赖
- **文件存储**: OSS（ali-oss，凭证从 `.env` 读）
- **部署**: 单机双服务，admin 50040 / public 50020（env 可覆盖）

## 角色

| 角色 | 能力 |
|------|------|
| **平台管理员** (`is_platform_admin=true`) | 管所有租户（建/改/暂停/恢复/删）、看所有审计日志、跨租户看数据 |
| **租户** | 只管自己的杂志/页/封面；不能看其他租户；不能进「平台管理」「审计日志」 |
| **公共访客** | 读 `/api/public/tenants/:slug/...` 看该租户的启用杂志 |

## 数据模型（schema v3）

### Tenant（租户）
| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER | 主键 |
| slug | TEXT | 唯一标识（如 `zhuobao`），URL 用，登录用 |
| name | TEXT | 显示名 |
| password | TEXT | 登录密码（空 = 不可登录） |
| is_platform_admin | BOOL | true = 平台管理员 |
| suspended | BOOL | true = 暂停（暂停后阅读端隐藏所有该租户数据 + 不可登录） |
| created_at | TEXT | ISO 时间 |

### Magazine（杂志）
| 字段 | 说明 |
|------|------|
| id, tenant_id, name, upload_date, description, cover_pc, cover_mobile, enabled, created_at | 旧字段 + tenant_id |

### Page / Cover
| 同旧 | 多 `tenant_id` 字段 |

### Audit Log（审计日志）
| 字段 | 说明 |
|------|------|
| id, timestamp | ISO |
| actor_tenant_id, actor_tenant_slug, actor_is_platform_admin | 谁干的 |
| tenant_id | 影响哪个租户（可能是其他租户） |
| action | login / login_failed / logout / create_tenant / update_tenant / delete_tenant / suspend_tenant / unsuspend_tenant / create_magazine / update_magazine / delete_magazine / add_page / add_pages_batch / reorder_pages / delete_page / create_cover / delete_cover / upload_file / publish |
| target_type, target_id | 哪个对象 |
| details | JSON（UI 翻译成人话展示） |
| ip, user_agent | 来源 |

> 保留最近 10000 条，超出自动截断。

## 端口

| 端口 | 服务 | env 覆盖 |
|------|------|---------|
| 50020 | 公共阅读端 + 公共读 API | `PUBLIC_PORT` |
| 50040 | 管理后台 + 后台 API | `ADMIN_PORT` |

## 关键 API

### Auth
- `POST /api/auth/login {slug, password}` → Set-Cookie mag_admin_sid
- `POST /api/auth/logout` → 清 cookie
- `GET /api/auth/me` → 当前 tenant 完整信息（含 is_platform_admin）

### 平台管理（requirePlatformAdmin）
- `GET /api/admin/tenants` → 全部租户 + 用量
- `POST /api/admin/tenants {slug, name, password?, is_platform_admin?}`
- `PUT /api/admin/tenants/:id {name?, password?, is_platform_admin?}`
- `POST /api/admin/tenants/:id/suspend` / `unsuspend`
- `DELETE /api/admin/tenants/:id`（级联删数据；不能删 platform admin）
- `GET /api/admin/audit-logs?tenantId=&actorTenantId=&action=&limit=&offset=`

### 杂志/页/封面 CRUD（requireAuth，按 tenant 隔离）
- 平台管理员可加 `?tenantId=X` 跨租户看
- 旧 API 全部保留：`/api/magazines`、`/api/magazines/:id/pages`、`/api/covers/upload` 等
- 所有写操作自动 audit log

### 公共读（不需要鉴权，永远跳过 suspended 租户）
- `GET /api/public/data` → 完整 live 快照，**阅读端默认走这个**
- `GET /api/public/tenants` → 全部非暂停租户
- `GET /api/public/tenants/:slug/magazines?enabled=1`
- `GET /api/public/tenants/:slug/magazines/:id`
- `GET /api/public/tenants/:slug/cover?type=pc|mobile`

### Publish（可选缓存层）
- `POST /api/admin/publish` → 把 data 推 OSS（带 5min CDN 缓存）
- 默认不需要：阅读端直接拉 `/api/public/data` 是 live 的

## 后台 UI 页面

| 页面 | 谁可见 | 功能 |
|------|--------|------|
| `/admin/login.html` | 任何人 | 登录 |
| `/admin/index.html` | 登录后 | 总览 + 统计卡 + SaaS 模式说明 |
| `/admin/magazine/list.html` | 登录后 | 杂志列表（含平台管理员可看 `?tenantId=`） |
| `/admin/magazine/edit.html?id=X` | 登录后 | 杂志编辑 + 页面管理 |
| `/admin/cover/list.html` | 登录后 | 封面管理 |
| `/admin/platform.html` | **平台管理员** | 租户列表 + CRUD + 暂停/恢复 + 删除 |
| `/admin/audit.html` | **平台管理员** | 审计日志查看 + 筛选 + 分页 |

后两个页面对非 platform admin 隐藏侧边栏入口（display:none + JS 切换）。

## 阅读端（公共）

3 页都从 `window.MAG_CONFIG.DATA_URL`（默认同源 `/api/public/data`）拉 live 数据，**不再走 OSS publish 桥**。数据是 real-time 的，admin 改完阅读端刷新立刻看到。

`public/config.js` 可改 `DATA_URL` 走 OSS / 跨域后端，但默认不需要。

## 项目结构

```
magazine-admin/
├── server/
│   ├── index.js          # Express 双服务启动（公共 + 后台）
│   ├── public.js         # 公共阅读端 app（含 /api/public/data）
│   ├── admin.js          # 后台 app（含 /api/admin/tenants + /api/admin/audit-logs）
│   ├── auth.js           # session + requirePlatformAdmin
│   └── db/
│       ├── data.json     # JSON 持久化（gitignore）
│       ├── init.js       # 数据操作 + audit_log helpers
│       └── migrate-to-v3.js  # 一次性迁移（已跑过，可删）
├── public/
│   ├── config.js         # window.MAG_CONFIG
│   ├── splash.html / directory.html / reader/viewer.html
│   └── admin/
│       ├── index.html / login.html / platform.html / audit.html
│       ├── magazine/ cover/
│       ├── css/style.css
│       └── js/api.js auth.js
├── scripts/build-reader.js
├── tools/                # 一次性迁移脚本（已跑过，可删）
├── .env                  # OSS 凭证 + ADMIN_PASSWORD（gitignore）
├── .gitignore
├── package.json
└── SPEC.md
```

## 启动

```bash
cd magazine-admin
npm install
npm start
# 公共阅读端 http://localhost:50020
# 后台登录   http://localhost:50040/admin/login.html
```

`.env` 必备：
```
OSS_REGION=oss-cn-beijing
OSS_BUCKET=openclawbsf
OSS_PREFIX=magazine-admin/covers/
OSS_ACCESS_KEY_ID=...
OSS_ACCESS_KEY_SECRET=...
ADMIN_PASSWORD=<默认 zhuobao 租户的密码，部署后改>
```

## 默认账号

- 租户 slug: `zhuobao`（首次启动自动成为 platform admin，schema v3 迁移时设置）
- 密码: `ADMIN_PASSWORD` env 决定（部署时换）
- **新租户** 通过「平台管理 → 新建租户」创建，初始密码由平台管理员设置

## 部署 Checklist

### 内网 / LAN（推荐起步）
1. 内网机器 `git pull && npm install && npm start`
2. 防火墙放行 50020 + 50040
3. 同事用 `http://<LAN-IP>:50040/admin/login.html` 登录
4. 阅读端用 `http://<LAN-IP>:50020/`

### SaaS（公网）
1. 同机起 admin + public（50040 / 50020），对外暴露
2. DNS：`zhuobao.example.com` 等子域名 → 同一公网 IP
3. 反代 nginx 配 `Host` 头传给 Node（req.tenant 按子域名解析 — 未来工作）
4. 平台管理员登录后建新租户、设置 slug 和密码
5. 阅读端用 `?t=slug` 切租户
