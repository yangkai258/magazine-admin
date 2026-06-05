// 公共阅读端 + 自助注册 + 公开 API
// 默认 port 50020，可由 PUBLIC_PORT env 覆盖
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

// ========== 公共读 API（多租户 SaaS） ==========
app.get('/api/public/data', (req, res) => {
  res.set('Cache-Control', 'no-cache, must-revalidate');
  res.json(db.snapshotForPublish());
});

app.get('/api/public/tenants', (req, res) => {
  res.json((db.getAllTenants() || []).filter(t => !t.suspended).map(t => ({
    id: t.id, slug: t.slug, name: t.name, logo_url: t.logo_url, primary_color: t.primary_color
  })));
});

app.get('/api/public/tenants/:slug/magazines', (req, res) => {
  const tenant = db.getTenantBySlug(req.params.slug);
  if (!tenant) return res.status(404).json({ error: 'tenant not found' });
  const { enabled } = req.query;
  const filter = enabled !== undefined ? { enabled } : { enabled: 1 };
  res.json(db.getAllMagazines({ tenantId: tenant.id, ...filter }));
});

app.get('/api/public/tenants/:slug/magazines/:id', (req, res) => {
  const tenant = db.getTenantBySlug(req.params.slug);
  if (!tenant) return res.status(404).json({ error: 'tenant not found' });
  const magazine = db.getMagazine(req.params.id, { tenantId: tenant.id });
  if (!magazine || magazine.enabled !== 1) return res.status(404).json({ error: 'magazine not found' });
  const pages = db.getPages(req.params.id, { tenantId: tenant.id });
  res.json({ ...magazine, pages });
});

app.get('/api/public/tenants/:slug/cover', (req, res) => {
  const tenant = db.getTenantBySlug(req.params.slug);
  if (!tenant) return res.status(404).json({ error: 'tenant not found' });
  const { type } = req.query;
  if (!type || !['pc', 'mobile'].includes(type)) return res.status(400).json({ error: 'type 必须是 pc 或 mobile' });
  const candidates = db.getAllCovers({ tenantId: tenant.id }).filter(c => c.type === type && c.magazine_id == null);
  if (candidates.length === 0) return res.status(404).json({ error: '该类型暂无封面' });
  res.json(candidates[0]);
});

// ========== 公开 Plans（注册页用） ==========
app.get('/api/public/plans', (req, res) => {
  res.json(db.getAllPlans().map(p => ({
    id: p.id, slug: p.slug, name: p.name, price_monthly_cny: p.price_monthly_cny, features: p.features
  })));
});

// ========== 自助注册（无需鉴权） ==========
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

// ========== Reader 端埋点（公开） ==========
app.post('/api/public/analytics/track', (req, res) => {
  const { tenant_slug, magazine_id, page_id, viewer_id, event_type, page_number, duration_ms } = req.body || {};
  if (!tenant_slug || !event_type) return res.status(400).json({ error: 'tenant_slug 和 event_type 必填' });
  const tenant = db.getTenantBySlug(tenant_slug);
  if (!tenant || tenant.suspended) return res.status(404).json({ error: 'tenant not found' });
  if (!['view', 'dwell', 'complete'].includes(event_type)) return res.status(400).json({ error: 'event_type 必须是 view/dwell/complete' });
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
