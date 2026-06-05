// 公共阅读端（默认 port 50010，可由 PUBLIC_PORT env 覆盖）：splash → directory → reader 三层
// 多租户版本：所有数据接口都按 tenant slug 隔离
// 注意：阅读端前端（splash/directory/viewer）走的是 OSS 上的 data.json（通过 publish 推上去），
// 本文件暴露的 /api/public/tenants/:slug/* 端点主要给：
//   1. 调试 / 监控用（admin 之外想看看某租户的公开数据长啥样）
//   2. 兜底场景（OSS 暂不可用时阅读端想拉单条数据）
// 阅读端默认不调这些接口，但保留它们以便服务发现和测试。
const express = require('express');
const path = require('path');
const db = require('./db/init');

const app = express();
app.use(express.json());

// 静态资源：splash.html / directory.html / reader/ / images/ + /uploads + /config.js
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));
app.get('/', (req, res) => res.redirect('/splash.html'));

// ========== 公共读 API（多租户） ==========
// 所有端点都是 GET，不需要鉴权，永远只返回 enabled=1 的杂志

// 1) 列出所有 tenant（不含 password）
app.get('/api/public/tenants', (req, res) => {
  const tenants = db.getAllTenants().map(t => ({
    id: t.id, slug: t.slug, name: t.name
    // 故意不返回 password / created_at
  }));
  res.json(tenants);
});

// 2) 某租户已启用的杂志列表
// GET /api/public/tenants/:slug/magazines?enabled=1
app.get('/api/public/tenants/:slug/magazines', (req, res) => {
  const tenant = db.getTenantBySlug(req.params.slug);
  if (!tenant) return res.status(404).json({ error: 'tenant not found' });

  const { enabled } = req.query;
  // 没传 enabled 时默认只返已启用的（公共读端约定）
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
// 优先返回该租户全局（magazine_id=null）的最新一张对应类型封面；
// 找不到 404，前端降级到 logo。
app.get('/api/public/tenants/:slug/cover', (req, res) => {
  const tenant = db.getTenantBySlug(req.params.slug);
  if (!tenant) return res.status(404).json({ error: 'tenant not found' });

  const { type } = req.query;
  if (!type || !['pc', 'mobile'].includes(type)) {
    return res.status(400).json({ error: 'type 必须是 pc 或 mobile' });
  }
  // getAllCovers 已按 created_at desc 排序；先取该租户 + 该类型，再过滤全局（magazine_id=null）
  const candidates = db.getAllCovers({ tenantId: tenant.id })
    .filter(c => c.type === type && c.magazine_id == null);
  if (candidates.length === 0) {
    return res.status(404).json({ error: '该类型暂无封面' });
  }
  res.json(candidates[0]);
});

module.exports = app;
