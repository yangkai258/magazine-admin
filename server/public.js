// 公共阅读端（默认 port 50020，可由 PUBLIC_PORT env 覆盖）：splash → directory → reader 三层
// 多租户 SaaS 模式：阅读端直接调本服务的 /api/public/data 拿 live 数据（不走 OSS 桥）
// OSS 只用于存图片资源（admin 上传时直接推 OSS，URL 存在 data.json 里被阅读端引用）
const express = require('express');
const path = require('path');
const db = require('./db/init');

const app = express();
app.use(express.json());

// 静态资源：splash.html / directory.html / reader/ / images/ + /uploads + /config.js
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));
app.get('/', (req, res) => res.redirect('/splash.html'));

// ========== 公共读 API（多租户 SaaS） ==========
// 所有端点都是 GET，不需要鉴权
// 主要：/api/public/data —— 阅读端 splash/directory/viewer 唯一调用的端点，返回 live 完整快照
// 其他几个 :slug/* 端点保留给调试 / 单条数据访问

// 0) 阅读端唯一入口：返回当前所有 tenant + magazines + pages + covers（live，不缓存）
// GET /api/public/data
app.get('/api/public/data', (req, res) => {
  res.set('Cache-Control', 'no-cache, must-revalidate');
  res.json(db.snapshotForPublish());
});

// 1) 列出所有 tenant（不含 password）
app.get('/api/public/tenants', (req, res) => {
  const tenants = db.getAllTenants().map(t => ({
    id: t.id, slug: t.slug, name: t.name
  }));
  res.json(tenants);
});

// 2) 某租户已启用的杂志列表
// GET /api/public/tenants/:slug/magazines?enabled=1
app.get('/api/public/tenants/:slug/magazines', (req, res) => {
  const tenant = db.getTenantBySlug(req.params.slug);
  if (!tenant) return res.status(404).json({ error: 'tenant not found' });

  const { enabled } = req.query;
  const filter = enabled !== undefined ? { enabled } : { enabled: 1 };
  const magazines = db.getAllMagazines({ tenantId: tenant.id, ...filter });
  res.json(magazines);
});

// 3) 某租户某杂志详情（含页面）
// GET /api/public/tenants/:slug/magazines/:id
app.get('/api/public/tenants/:slug/magazines/:id', (req, res) => {
  const tenant = db.getTenantBySlug(req.params.slug);
  if (!tenant) return res.status(404).json({ error: 'tenant not found' });

  const magazine = db.getMagazine(req.params.id, { tenantId: tenant.id });
  if (!magazine || magazine.enabled !== 1) {
    return res.status(404).json({ error: 'magazine not found' });
  }
  const pages = db.getPages(req.params.id, { tenantId: tenant.id });
  res.json({ ...magazine, pages });
});

// 4) 某租户某类型最新封面（开屏/前台用）
// GET /api/public/tenants/:slug/cover?type=pc|mobile
app.get('/api/public/tenants/:slug/cover', (req, res) => {
  const tenant = db.getTenantBySlug(req.params.slug);
  if (!tenant) return res.status(404).json({ error: 'tenant not found' });

  const { type } = req.query;
  if (!type || !['pc', 'mobile'].includes(type)) {
    return res.status(400).json({ error: 'type 必须是 pc 或 mobile' });
  }
  const candidates = db.getAllCovers({ tenantId: tenant.id })
    .filter(c => c.type === type && c.magazine_id == null);
  if (candidates.length === 0) {
    return res.status(404).json({ error: '该类型暂无封面' });
  }
  res.json(candidates[0]);
});

module.exports = app;
