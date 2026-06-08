// 公共阅读端 + 自助注册 + 公开 API
// 默认 port 50020，可由 PUBLIC_PORT env 覆盖
// v5：reader 端 URL 鉴权（?t=<slug>&s=<secret>），所有 /api/public/* 需要 secret
//     开放：plans / signup / signup-verify
const express = require('express');
const path = require('path');
const db = require('./db/init');
const smtp = require('./smtp');

const app = express();
app.set('trust proxy', true);
app.use(express.json());

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));
app.get('/', (req, res) => res.redirect('/splash.html'));

// ========== Reader Secret 鉴权 (v5) ==========
// 从 header / query 拿 secret；header 优先
function extractReaderSecret(req) {
  return (req.get('X-Reader-Secret') || req.query.secret || '').trim() || null;
}

// 用 secret 找匹配的非 suspended tenant；找不到返回 null
function findTenantBySecret(secret) {
  if (!secret) return null;
  return (db.getAllTenants() || []).find(t => t.reader_secret === secret && !t.suspended) || null;
}

// 校验 secret；缺/错 → 401。中间件式。
// 模式 A：有具体 slug（path 或 query）→ secret 必须 match 那个 slug
// 模式 B：无 slug（list/data）→ secret 必须 match 任意 tenant（返回该 tenant 供后续使用）
function requireReaderAuth(req, res, slug) {
  const secret = extractReaderSecret(req);
  if (!secret) {
    return res.status(401).json({ error: 'invalid_secret', message: '缺少 X-Reader-Secret header 或 ?secret= query' });
  }
  const tenant = findTenantBySecret(secret);
  if (!tenant) {
    return res.status(401).json({ error: 'invalid_secret', message: 'secret 不匹配任何 tenant' });
  }
  if (slug && tenant.slug !== slug) {
    return res.status(401).json({ error: 'invalid_secret', message: 'secret 与 slug 不匹配' });
  }
  return null;  // 鉴权通过；用 req._readerTenant 拿当前 tenant
}

// 给 list / data 端点用：secret 必须 match 某个 tenant，并把 tenant 挂到 req
function requireReaderAuthAttach(req, res) {
  const secret = extractReaderSecret(req);
  if (!secret) {
    return res.status(401).json({ error: 'invalid_secret' });
  }
  const tenant = findTenantBySecret(secret);
  if (!tenant) {
    return res.status(401).json({ error: 'invalid_secret' });
  }
  req._readerTenant = tenant;
  return null;
}

// 静默鉴权：失败不返 401，只返 { success: false }，不泄漏信息给爬虫
function requireReaderAuthSilent(req, res) {
  const secret = extractReaderSecret(req);
  const tenant = secret ? findTenantBySecret(secret) : null;
  return { secret, tenant };
}

// ========== 公共读 API（多租户 SaaS，需要 reader secret） ==========
// /api/public/data?slug=<slug>&secret=<secret>  或  ?slug=<slug> + X-Reader-Secret header
// 不带 slug → 401；缺/错 secret → 401；通过 → 该租户的快照
app.get('/api/public/data', (req, res) => {
  if (requireReaderAuthAttach(req, res)) return;
  const tenant = req._readerTenant;
  const slug = (req.query.slug || '').trim();
  // 没传 slug：默认就用 secret 自己的 tenant（最常见用法）
  if (slug && slug !== tenant.slug) {
    return res.status(401).json({ error: 'invalid_secret', message: 'slug 与 secret 不匹配' });
  }
  res.set('Cache-Control', 'no-cache, must-revalidate');
  res.json(db.snapshotForPublish({ tenantId: tenant.id }));
});

// /api/public/tenants?slug=<slug>&secret=<secret>  或  ?slug=<slug> + header
// 缺 slug 或 缺/错 secret → 401；通过 → 单租户
app.get('/api/public/tenants', (req, res) => {
  if (requireReaderAuthAttach(req, res)) return;
  const tenant = req._readerTenant;
  const slug = (req.query.slug || '').trim();
  if (slug && slug !== tenant.slug) {
    return res.status(401).json({ error: 'invalid_secret', message: 'slug 与 secret 不匹配' });
  }
  // 响应不包含 reader_secret
  res.json([{
    id: tenant.id, slug: tenant.slug, name: tenant.name,
    logo_url: tenant.logo_url || '',
    primary_color: tenant.primary_color || '#4f46e5'
  }]);
});

// slug 路由：requireReaderAuth 已经确认 secret 匹配了某个 tenant，且该 tenant.slug === req.params.slug
// （不匹配会返 401，不会走到这里）。所以不再二次查 tenant，直接信任 slug 取数据。
function publicTenantBySlug(req, res) {
  if (requireReaderAuth(req, res, req.params.slug)) return null;
  return db.getTenantBySlug(req.params.slug);
}

app.get('/api/public/tenants/:slug/magazines', (req, res) => {
  const tenant = publicTenantBySlug(req, res);
  if (!tenant) return;  // 401 或 404 已写
  const { enabled } = req.query;
  const filter = enabled !== undefined ? { enabled } : { enabled: 1 };
  res.json(db.getAllMagazines({ tenantId: tenant.id, ...filter }));
});

app.get('/api/public/tenants/:slug/magazines/:id', (req, res) => {
  const tenant = publicTenantBySlug(req, res);
  if (!tenant) return;
  const magazine = db.getMagazine(req.params.id, { tenantId: tenant.id });
  if (!magazine || magazine.enabled !== 1) return res.status(404).json({ error: 'magazine not found' });
  const pages = db.getPages(req.params.id, { tenantId: tenant.id });
  res.json({ ...magazine, pages });
});

app.get('/api/public/tenants/:slug/cover', (req, res) => {
  const tenant = publicTenantBySlug(req, res);
  if (!tenant) return;
  const { type } = req.query;
  if (!type || !['pc', 'mobile'].includes(type)) return res.status(400).json({ error: 'type 必须是 pc 或 mobile' });
  const candidates = db.getAllCovers({ tenantId: tenant.id }).filter(c => c.type === type && c.magazine_id == null);
  if (candidates.length === 0) return res.status(404).json({ error: '该类型暂无封面' });
  res.json(candidates[0]);
});

// ========== 公开 Plans（注册页用，无需 secret） ==========
app.get('/api/public/plans', (req, res) => {
  res.json(db.getAllPlans().map(p => ({
    id: p.id, slug: p.slug, name: p.name, price_monthly_cny: p.price_monthly_cny, features: p.features
  })));
});

// ========== 自助注册（无需 secret） ==========
app.post('/api/public/signup', async (req, res) => {
  const { email, tenant_slug, tenant_name, plan_id } = req.body || {};
  if (!email || !tenant_slug || !tenant_name) return res.status(400).json({ error: 'email / tenant_slug / tenant_name 必填' });
  if (!/^[a-z0-9-]{2,32}$/.test(tenant_slug)) return res.status(400).json({ error: 'slug 只能 a-z 0-9 -，2-32 字符' });
  if (db.getTenantBySlug(tenant_slug)) return res.status(400).json({ error: 'slug 已被占用' });
  if (db.getUserByEmail(null, email) || (db.getAllUsers() || []).some(u => u.email === email.toLowerCase())) {
    return res.status(400).json({ error: '邮箱已被注册' });
  }
  const tok = db.createSignupToken({ email, tenant_slug, tenant_name, token: db.randomToken(), expires_in_hours: 24 });
  const link = `${req.protocol}://${req.get('host')}/admin/signup-verify.html?token=${tok.token}`;
  try {
    await smtp.sendMail({
      to: email,
      subject: `【杂志管理平台】验证你的邮箱并开通「${tenant_name}」`,
      text: `感谢注册！点击下面链接 24 小时内验证邮箱并完成开通：\n\n${link}\n\n租户标识：${tenant_slug}\n显示名：${tenant_name}`
    });
  } catch (e) { console.error('[signup] sendMail failed:', e.message); }
  res.json({ success: true, verify_link: link, expires_at: tok.expires_at });
});

app.get('/api/public/signup/verify', (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'token 必填' });
  const tok = db.getSignupToken(token);
  if (!tok || tok.used_at) return res.status(400).json({ error: '链接无效或已使用' });
  if (new Date(tok.expires_at) < new Date()) return res.status(400).json({ error: '链接已过期' });
  // 创建 tenant + owner user（初始密码 = 随机 token 的一部分）
  const initialPassword = db.randomToken(8);  // 16 字符
  const tenant = db.createTenant({ slug: tok.tenant_slug, name: tok.tenant_name, plan_id: 1 });
  const user = db.createUser({ tenant_id: tenant.id, email: tok.email, name: tok.tenant_name, role: 'owner', password: initialPassword });
  db.markSignupTokenUsed(token);
  res.json({
    success: true,
    tenant_slug: tenant.slug,
    tenant_name: tenant.name,
    user_email: user.email,
    initial_password: initialPassword,
    message: '租户已创建。请用 email + 上述初始密码登录，登录后请立即修改密码。'
  });
});

// ========== Reader 端埋点（v5：body 加 secret 字段，静默校验） ==========
// 失败 → silently 返回 200 { success: false }（不返 401，不泄漏信息给爬虫）
app.post('/api/public/analytics/track', (req, res) => {
  const { tenant_slug, secret, magazine_id, page_id, viewer_id, event_type, page_number, duration_ms } = req.body || {};
  // 静默鉴权：secret 缺/错/不匹配该 tenant → 直接返 success: false（不写入）
  if (!tenant_slug || !secret) return res.json({ success: false });
  const tenant = db.getTenantBySlug(tenant_slug);
  if (!tenant || tenant.suspended) return res.json({ success: false });
  if (tenant.reader_secret !== secret) return res.json({ success: false });
  if (!event_type) return res.json({ success: false });
  if (!['view', 'dwell', 'complete'].includes(event_type)) return res.json({ success: false });
  db.addReaderEvent({
    tenant_id: tenant.id,
    magazine_id,
    page_id,
    viewer_id: viewer_id || req.ip,  // 简化用 IP hash
    event_type,
    page_number,
    duration_ms,
    referrer: req.headers.referer || null,
    user_agent: req.headers['user-agent'] || null
  });
  res.json({ success: true });
});

module.exports = app;
