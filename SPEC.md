# 杂志管理平台 - Magazine Admin CMS

## 概念与愿景

企业内部杂志管理平台，支持《卓宝人》等电子杂志的数字化管理。平台提供 **封面管理** 和 **杂志管理** 两大核心功能，支持桌面端和移动端分别管理封面，杂志页面支持单页上传、批量上传和拖拽排序。

## 技术栈

- **后端**: Express.js + JSON 文件存储（零依赖，SQLite因编译问题改用JSON）
- **前端**: 原生 HTML/CSS/JS，无框架依赖
- **文件存储**: 本地 `public/uploads/` 目录（或映射到 OSS）
- **端口**:
  - 公共阅读端（`server/public.js`）：**50020**（可由 `PUBLIC_PORT` env 覆盖）—— splash → directory → reader
  - 管理后台（`server/admin.js`）：**50040**（可由 `ADMIN_PORT` env 覆盖）—— `/admin/` 全部 CRUD + 上传
  - 共享同一份 `db/data.json`

## 数据模型（JSON文件存储）

### Magazine（杂志）
| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER | 主键自增 |
| name | TEXT | 杂志名称 |
| upload_date | TEXT | 上传日期（YYYY-MM-DD） |
| description | TEXT | 内容介绍 |
| cover_pc | TEXT | PC端封面图路径 |
| cover_mobile | TEXT | 移动端封面图路径 |
| enabled | INTEGER | 启用(1)/停用(0) |
| created_at | TEXT | 创建时间 |

### MagazinePage（杂志页）
| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER | 主键自增 |
| magazine_id | INTEGER | 所属杂志ID |
| page_order | INTEGER | 排序顺序 |
| image_path | TEXT | 页面图片路径 |
| created_at | TEXT | 创建时间 |

### Cover（封面）
| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER | 主键自增 |
| magazine_id | INTEGER | 所属杂志ID（可为空） |
| type | TEXT | pc / mobile |
| image_path | TEXT | 封面图片路径 |
| created_at | TEXT | 创建时间 |

## 功能模块

### 1. 封面管理（/cover/list.html）
- **PC端封面**: 列表展示，可按杂志筛选
- **移动端封面**: 列表展示，可按杂志筛选
- Tab切换：PC端 / 移动端
- 上传、删除功能

### 2. 杂志管理（/magazine/list.html）
- **杂志列表页**: 
  - 表格展示：杂志名称、上传日期、状态（启用/停用）、操作
  - 支持查询（按名称搜索）
  - 支持新增、编辑、删除、启用/停用
- **杂志详情页**（/magazine/edit.html?id=x）:
  - 基本信息编辑（名称、日期、介绍、封面URL）
  - 页面管理：显示所有页面缩略图
  - **单页上传**：一次传一张
  - **批量上传**：一次传多张
  - **拖拽排序**：直接拖拽调整顺序，自动保存

### 3. 管理端 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/magazines | 杂志列表（支持?search=&enabled=） |
| GET | /api/magazines/:id | 获取杂志详情+页面列表 |
| POST | /api/magazines | 新增杂志 |
| PUT | /api/magazines/:id | 更新杂志 |
| DELETE | /api/magazines/:id | 删除杂志（级联删页面） |
| POST | /api/magazines/:id/pages | 新增单页 |
| POST | /api/magazines/:id/pages/batch | 批量新增页面 |
| PUT | /api/magazines/:id/pages/reorder | 拖拽排序 |
| DELETE | /api/magazines/:id/pages/:pageId | 删除杂志页 |
| POST | /api/covers/upload | 上传封面图（type=pc/mobile） |
| GET | /api/covers | 封面列表 |
| DELETE | /api/covers/:id | 删除封面 |

### 4. 公共读 API（前台用，永远只返回 enabled=1）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/public/magazines | 已启用的杂志列表 |
| GET | /api/public/magazines/:id | 已启用单本杂志详情+页面列表（404 if 未启用） |

## 三层公共阅读体验（封面 → 目录 → 内容）

| 入口 | 页面 | 说明 |
|------|------|------|
| 开屏 | `public/splash.html` | 3s 自动跳，logo + 标题 + 分割线依次淡入；点屏幕或"点击跳过"按钮立即跳目录 |
| 目录 | `public/directory.html` | 卡片列表，动态拉 `/api/magazines?enabled=1` |
| 阅读 | `public/reader/viewer.html?id=X` | 桌面双页翻书（turn.js），首末页单图、中间页 left+right spread；移动端单页横滑+双指缩放；首页图片预加载防闪白 |

## 项目结构

```
magazine-admin/
├── .gitignore
├── package.json
├── README.md
├── SPEC.md
├── server/
│   ├── index.js          # Express 服务（管理 + 公共读 两套端点）
│   └── db/
│       ├── data.json     # JSON 持久化（gitignore）
│       └── init.js       # 数据操作
├── public/
│   ├── splash.html       # 开屏（公共）
│   ├── directory.html    # 杂志目录（公共）
│   ├── images/           # logo 等
│   ├── reader/           # 公共阅读器
│   │   ├── viewer.html   # 动态翻页（响应 ?id=）
│   │   └── lib/          # jquery.min.js / turn.min.js
│   └── admin/            # 后台管理 UI
│       ├── index.html    # 总览
│       ├── css/style.css
│       ├── js/api.js
│       ├── magazine/     # 杂志管理
│       └── cover/        # 封面管理
└── uploads/              # 上传文件目录（gitignore）
```

## 交付状态

✅ 功能全部完成，代码已就绪。启动方式：

```bash
cd magazine-admin
npm install
npm start
# 同时启动两端：
#   公共阅读端 http://localhost:50020
#   管理后台   http://localhost:50040
```

## 局域网（LAN）部署

数据仍然走 OSS 当中间桥：admin 推 `data.json` 到 OSS → 阅读端从 OSS 拉。
admin + reader 两个服务跑在同一台内网机器上，LAN 同事直接用：

```text
后端：    http://<本机 LAN IP>:50040/admin/login.html
阅读端：http://<本机 LAN IP>:50020/

默认账号：slug = zhuobao
默认密码：见 .env 的 ADMIN_PASSWORD
```

**获取本机 LAN IP**：
```powershell
Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' }
```

**Windows 防火墙**（首次部署如果同事访问不到）：
```powershell
New-NetFirewallRule -DisplayName "Magazine Admin 50040" -Direction Inbound -LocalPort 50040 -Protocol TCP -Action Allow
New-NetFirewallRule -DisplayName "Magazine Reader 50020" -Direction Inbound -LocalPort 50020 -Protocol TCP -Action Allow
```

**环境变量覆盖**（如果默认端口被占）：
```bash
PUBLIC_PORT=50021 ADMIN_PORT=50041 npm start
```

**OSS 数据发布链路**：
1. 同事在 admin 后台改完数据
2. 点击 admin 顶部的「发布到阅读端」按钮（如果有）→ 调 `POST /api/admin/publish`
3. 后端把 data.json 推到 OSS `magazine-admin/data.json`（CDN 缓存 5 分钟）
4. 阅读端刷新即可看到新数据（≤ 5 分钟内）

> 阅读端 HTML 直接 fetch OSS 上的 data.json（`https://openclawbsf.oss-cn-beijing.aliyuncs.com/magazine-admin/data.json`），所以 reader 跑在哪台机器不重要，**只要本机 + OSS 通**就行。
