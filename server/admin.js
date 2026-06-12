// 管理后台（默认 port 50040，可由 ADMIN_PORT env 覆盖）
// v4：基于 user 的鉴权 + 角色（owner/editor/viewer）+ 多用户 + 平台管理 + 审计 + 品牌定制
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const OSS = require('ali-oss');
const db = require('./db/init');
const auth = require('./auth');
const smtp = require('./smtp');
const payment = require('./payment');
const aiClient = require('./ai-client');
const rateLimit = require('./rate-limit');

const app = express();
app.set('trust proxy', true);
app.use(cors());
app.use(express.json());

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));
app.get('/', (req, res) => res.redirect('/admin/'));

app.use(auth.attachSession);

// OSS 客户端
let ossClient = null;
if (process.env.OSS_ACCESS_KEY_ID && process.env.OSS_ACCESS_KEY_SECRET) {
  ossClient = new OSS({
    region: process.env.OSS_REGION || 'oss-cn-beijing',
    accessKeyId: process.env.OSS_ACCESS_KEY_ID,
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
    bucket: process.env.OSS_BUCKET || 'openclawbsf',
    secure: true
  });
  console.log('[oss] client ready');
} else {
  console.warn('[oss] credentials not set');
}
const OSS_PREFIX = process.env.OSS_PREFIX || 'magazine-admin/covers/';
const OSS_LOGO_PREFIX = 'magazine-admin/logos/';
const OSS_PUBLISH_KEY = 'magazine-admin/data.json';
const OSS_PUBLISH_TTL_S = 300;

const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

async function persistUpload(file, prefix) {
  const ext = path.extname(file.originalname) || '.bin';
  const randomName = Date.now() + '-' + Math.round(Math.random() * 1e9) + ext;
  const key = (prefix || OSS_PREFIX) + randomName;
  if (ossClient) {
    const result = await ossClient.put(key, file.buffer, { headers: { 'Cache-Control': 'public, max-age=31536000' } });
    return { path: result.url, filename: randomName, ossKey: key };
  }
  const dst = path.join(__dirname, '..', 'uploads', randomName);
  fs.writeFileSync(dst, file.buffer);
  return { path: '/uploads/' + randomName, filename: randomName };
}

// ========== Auth ==========
app.post('/api/auth/login', (req, res) => {
  const { slug, email, password } = req.body || {};
  if (!slug || !password) return res.status(400).json({ error: 'slug 和 password 必填' });
  const result = auth.login(slug, email, password, req);
  if (!result.ok) return res.status(401).json({ error: result.error });
  auth.setSessionCookie(res, result.sid);
  res.json({ success: true, tenant: result.tenant, user: result.user });
});

app.post('/api/auth/logout', (req, res) => {
  auth.logout(req);
  auth.clearSessionCookie(res);
  res.json({ success: true });
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session) return res.status(401).json({ error: '未登录', code: 'AUTH_REQUIRED' });
  res.json({ tenant: req.tenant, user: req.user });
});

// 忘记密码：发邮件
app.post('/api/auth/forgot-password', async (req, res) => {
  const { slug, email } = req.body || {};
  if (!slug || !email) return res.status(400).json({ error: 'slug 和 email 必填' });
  const tenant = db.getTenantBySlug(slug);
  if (!tenant) return res.status(404).json({ error: '租户不存在' });
  const user = db.getUserByEmail(tenant.id, email);
  // 即便 user 不存在也返 200（防枚举）
  if (user) {
    const tok = db.createPasswordResetToken(user.id);
    const link = `${req.protocol}://${req.get('host')}/admin/reset-password.html?token=${tok.token}`;
    try {
      await smtp.sendMail({
        to: email,
        subject: `【杂志管理平台】重置你的密码`,
        text: `你好 ${user.name}，\n\n点击下面的链接重置密码（1 小时内有效）：\n${link}\n\n如果不是本人操作请忽略。`
      });
    } catch (e) {
      console.error('[forgot-password] sendMail failed:', e.message);
    }
    auth.audit({ session: { userId: null, tenantId: tenant.id, isPlatformAdmin: false }, user: { id: user.id, email, role: user.role }, tenant, ip: req.ip, headers: req.headers }, 'password_reset_requested', { tenant_id: tenant.id, target_type: 'user', target_id: user.id, details: { email } });
  }
  res.json({ success: true });
});

app.post('/api/auth/reset-password', (req, res) => {
  const { token, new_password } = req.body || {};
  if (!token || !new_password) return res.status(400).json({ error: 'token 和 new_password 必填' });
  if (new_password.length < 6) return res.status(400).json({ error: '密码至少 6 位' });
  const tok = db.getPasswordResetToken(token);
  if (!tok || tok.used_at) return res.status(400).json({ error: '链接无效' });
  if (new Date(tok.expires_at) < new Date()) return res.status(400).json({ error: '链接已过期，请重新申请' });
  db.setUserPassword(tok.user_id, new_password);
  db.markPasswordResetTokenUsed(token);
  res.json({ success: true });
});

// ========== 平台管理：租户 CRUD（仅 platform_admin） ==========
app.get('/api/admin/tenants', auth.requirePlatformAdmin, (req, res) => {
  const tenants = db.getAllTenants().map(t => ({
    id: t.id, slug: t.slug, name: t.name, logo_url: t.logo_url, primary_color: t.primary_color,
    is_platform_admin: !!t.is_platform_admin, suspended: !!t.suspended,
    plan_id: t.plan_id, subscription_status: t.subscription_status,
    has_password: !!t.password, created_at: t.created_at,
    usage: db.getTenantUsage(t.id)
  }));
  res.json(tenants);
});

app.post('/api/admin/tenants', auth.requirePlatformAdmin, (req, res) => {
  const { slug, name, plan_id, logo_url, primary_color } = req.body || {};
  if (!slug || !name) return res.status(400).json({ error: 'slug 和 name 必填' });
  if (!/^[a-z0-9-]{2,32}$/.test(slug)) return res.status(400).json({ error: 'slug 只能 a-z 0-9 -，2-32 字符' });
  try {
    const tenant = db.createTenant({ slug, name, plan_id, logo_url, primary_color });
    auth.audit(req, 'create_tenant', { tenant_id: tenant.id, target_type: 'tenant', target_id: tenant.id, details: { slug, name, plan_id } });
    res.json({ id: tenant.id, slug: tenant.slug, name: tenant.name });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/admin/tenants/:id', auth.requirePlatformAdmin, (req, res) => {
  const { name, plan_id, logo_url, primary_color, suspended } = req.body || {};
  const fields = {};
  if (name !== undefined) fields.name = name;
  if (plan_id !== undefined) fields.plan_id = plan_id;
  if (logo_url !== undefined) fields.logo_url = logo_url;
  if (primary_color !== undefined) fields.primary_color = primary_color;
  if (suspended !== undefined) fields.suspended = !!suspended;
  const tenant = db.updateTenant(req.params.id, fields);
  if (!tenant) return res.status(404).json({ error: '租户不存在' });
  auth.audit(req, 'update_tenant', { target_type: 'tenant', target_id: tenant.id, details: Object.keys(fields) });
  res.json({ id: tenant.id, slug: tenant.slug, name: tenant.name });
});

app.post('/api/admin/tenants/:id/suspend', auth.requirePlatformAdmin, (req, res) => {
  const tenant = db.getTenant(req.params.id);
  if (!tenant) return res.status(404).json({ error: '租户不存在' });
  if (tenant.is_platform_admin) return res.status(400).json({ error: '不能暂停平台管理员租户' });
  db.setTenantSuspended(req.params.id, true);
  auth.audit(req, 'suspend_tenant', { target_type: 'tenant', target_id: tenant.id });
  res.json({ success: true });
});

app.post('/api/admin/tenants/:id/unsuspend', auth.requirePlatformAdmin, (req, res) => {
  const tenant = db.getTenant(req.params.id);
  if (!tenant) return res.status(404).json({ error: '租户不存在' });
  db.setTenantSuspended(req.params.id, false);
  auth.audit(req, 'unsuspend_tenant', { target_type: 'tenant', target_id: tenant.id });
  res.json({ success: true });
});

app.delete('/api/admin/tenants/:id', auth.requirePlatformAdmin, (req, res) => {
  const tenant = db.getTenant(req.params.id);
  if (!tenant) return res.status(404).json({ error: '租户不存在' });
  if (tenant.is_platform_admin) return res.status(400).json({ error: '不能删除平台管理员租户' });
  auth.audit(req, 'delete_tenant', { target_type: 'tenant', target_id: tenant.id, details: { slug: tenant.slug, name: tenant.name } });
  db.deleteTenant(req.params.id);
  res.json({ success: true });
});

// ========== 平台管理：用户 CRUD（仅 platform_admin，可跨租户） ==========
app.get('/api/admin/users', auth.requirePlatformAdmin, (req, res) => {
  const { tenantId } = req.query;
  res.json(db.getAllUsers({ tenantId: tenantId ? Number(tenantId) : undefined }).map(u => {
    const t = db.getTenant(u.tenant_id);
    return {
      id: u.id, tenant_id: u.tenant_id, tenant_slug: t ? t.slug : null, tenant_name: t ? t.name : null,
      email: u.email, name: u.name, role: u.role, status: u.status,
      created_at: u.created_at, last_login_at: u.last_login_at
    };
  }));
});

// ========== 租户自己的用户管理（owner 才能邀请/删） ==========
app.get('/api/admin/tenant/users', auth.requireAuth, (req, res) => {
  res.json(db.getAllUsers({ tenantId: req.tenant.id }).map(u => ({
    id: u.id, email: u.email, name: u.name, role: u.role, status: u.status,
    created_at: u.created_at, last_login_at: u.last_login_at
  })));
});

app.post('/api/admin/tenant/users', auth.requireRole('owner'), async (req, res) => {
  const { email, name, role, password } = req.body || {};
  if (!email || !role || !password) return res.status(400).json({ error: 'email / role / password 必填' });
  if (!['owner', 'editor', 'viewer'].includes(role)) return res.status(400).json({ error: 'role 必须是 owner/editor/viewer' });
  try {
    const user = db.createUser({ tenant_id: req.tenant.id, email, name, role, password });
    auth.audit(req, 'create_user', { target_type: 'user', target_id: user.id, details: { email, role } });
    res.json({ id: user.id, email: user.email, name: user.name, role: user.role });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/admin/tenant/users/:id', auth.requireRole('owner'), (req, res) => {
  const { name, role, password } = req.body || {};
  const user = db.getUser(req.params.id);
  if (!user || user.tenant_id !== req.tenant.id) return res.status(404).json({ error: '用户不存在' });
  if (role && !['owner', 'editor', 'viewer'].includes(role)) return res.status(400).json({ error: 'role 必须是 owner/editor/viewer' });
  const fields = {};
  if (name !== undefined) fields.name = name;
  if (role !== undefined) fields.role = role;
  if (password) fields.password = password;
  db.updateUser(user.id, fields);
  auth.audit(req, 'update_user', { target_type: 'user', target_id: user.id, details: { changed: Object.keys(fields) } });
  res.json({ id: user.id, email: user.email, name: user.name, role: user.role });
});

app.delete('/api/admin/tenant/users/:id', auth.requireRole('owner'), (req, res) => {
  const user = db.getUser(req.params.id);
  if (!user || user.tenant_id !== req.tenant.id) return res.status(404).json({ error: '用户不存在' });
  if (user.id === req.user.id) return res.status(400).json({ error: '不能删除自己' });
  db.deleteUser(user.id);
  auth.audit(req, 'delete_user', { target_type: 'user', target_id: user.id, details: { email: user.email } });
  res.json({ success: true });
});

// 邀请用户：发邮件，对方点链接接受
app.post('/api/admin/tenant/users/invite', auth.requireRole('owner'), async (req, res) => {
  const { email, role } = req.body || {};
  if (!email || !role) return res.status(400).json({ error: 'email 和 role 必填' });
  if (!['owner', 'editor', 'viewer'].includes(role)) return res.status(400).json({ error: 'role 必须是 owner/editor/viewer' });
  // 如果已存在 user，直接返回
  const existing = db.getUserByEmail(req.tenant.id, email);
  if (existing) return res.status(400).json({ error: '该邮箱已经是本租户用户' });
  const inv = db.createUserInvitation({ tenant_id: req.tenant.id, email, role, invited_by: req.user.id, expires_in_hours: 72 });
  const link = `${req.protocol}://${req.get('host')}/admin/accept-invite.html?token=${inv.token}`;
  try {
    await smtp.sendMail({
      to: email,
      subject: `【${req.tenant.name}】邀请你加入管理后台`,
      text: `${req.user.name} 邀请你加入「${req.tenant.name}」杂志管理后台，角色：${role}。\n\n点击接受（72 小时内有效）：\n${link}`
    });
  } catch (e) { console.error('[invite] sendMail failed:', e.message); }
  auth.audit(req, 'invite_user', { target_type: 'user_invitation', target_id: inv.id, details: { email, role } });
  res.json({ success: true, invitation_id: inv.id, accept_link: link });
});

app.get('/api/admin/tenant/invitations', auth.requireRole('owner'), (req, res) => {
  res.json(db.getUserInvitations(req.tenant.id).map(i => ({ id: i.id, email: i.email, role: i.role, expires_at: i.expires_at, accepted_at: i.accepted_at, created_at: i.created_at })));
});

app.post('/api/auth/accept-invite', (req, res) => {
  const { token, name, password } = req.body || {};
  if (!token || !name || !password) return res.status(400).json({ error: 'token / name / password 必填' });
  const inv = db.getUserInvitationByToken(token);
  if (!inv || inv.accepted_at) return res.status(400).json({ error: '邀请无效或已使用' });
  if (new Date(inv.expires_at) < new Date()) return res.status(400).json({ error: '邀请已过期' });
  try {
    const user = db.createUser({ tenant_id: inv.tenant_id, email: inv.email, name, role: inv.role, password });
    db.markUserInvitationAccepted(token);
    res.json({ success: true, tenant_slug: db.getTenant(inv.tenant_id).slug });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ========== 审计日志（仅 platform_admin） ==========
app.get('/api/admin/audit-logs', auth.requirePlatformAdmin, (req, res) => {
  const { tenantId, actorUserId, action, limit, offset } = req.query;
  const result = db.getAuditLogs({
    tenantId: tenantId ? Number(tenantId) : undefined,
    actorUserId: actorUserId ? Number(actorUserId) : undefined,
    action,
    limit: Math.min(Number(limit) || 200, 1000),
    offset: Number(offset) || 0
  });
  res.json(result);
});

// ========== Plans / Subscriptions / Invoices ==========
app.get('/api/admin/plans', auth.requireAuth, (req, res) => {
  res.json(db.getAllPlans().map(p => ({ id: p.id, slug: p.slug, name: p.name, price_monthly_cny: p.price_monthly_cny, features: p.features })));
});

app.get('/api/admin/subscription', auth.requireAuth, (req, res) => {
  const sub = db.getActiveSubscription(req.tenant.id);
  const tenant = db.getTenant(req.tenant.id);
  const plan = tenant && tenant.plan_id ? db.getPlan(tenant.plan_id) : null;
  res.json({
    plan: plan ? { id: plan.id, slug: plan.slug, name: plan.name, price_monthly_cny: plan.price_monthly_cny, features: plan.features } : null,
    subscription: sub,
    trial_ends_at: tenant ? tenant.trial_ends_at : null
  });
});

app.get('/api/admin/invoices', auth.requireAuth, (req, res) => {
  res.json(db.getInvoices(req.tenant.id).map(i => ({
    id: i.id, plan_id: i.plan_id, amount_cny: i.amount_cny, currency: i.currency,
    period_start: i.period_start, period_end: i.period_end, status: i.status,
    payment_method: i.payment_method, external_id: i.external_id,
    created_at: i.created_at, paid_at: i.paid_at
  })));
});

// 触发支付（创建 invoice + 调支付）
app.post('/api/admin/payment/create', auth.requireRole('owner'), async (req, res) => {
  const { plan_id, method } = req.body || {};  // method: 'alipay' | 'wechat'
  const plan = db.getPlan(plan_id);
  if (!plan) return res.status(404).json({ error: '套餐不存在' });
  if (!['alipay', 'wechat'].includes(method)) return res.status(400).json({ error: 'method 必须是 alipay/wechat' });
  const inv = db.createInvoice({ tenant_id: req.tenant.id, plan_id, amount_cny: plan.price_monthly_cny, status: 'pending', payment_method: method });
  auth.audit(req, 'create_invoice', { target_type: 'invoice', target_id: inv.id, details: { plan_id, method, amount: plan.price_monthly_cny } });
  let order;
  try {
    order = method === 'alipay'
      ? await payment.createAlipayOrder({ invoice_id: inv.id, amount_cny: inv.amount_cny, subject: `${plan.name} 月费` })
      : await payment.createWechatOrder({ invoice_id: inv.id, amount_cny: inv.amount_cny, subject: `${plan.name} 月费` });
  } catch (e) {
    db.updateInvoice(inv.id, { status: 'failed' });
    return res.status(500).json({ error: '创建支付订单失败: ' + e.message });
  }
  res.json({ invoice_id: inv.id, method, amount_cny: inv.amount_cny, ...order });
});

// 支付 mock 完成（仅开发用，真支付走异步 notify）
app.post('/api/admin/payment/mock-paid', auth.requireRole('owner'), (req, res) => {
  const { invoice_id } = req.body || {};
  const inv = db.getInvoices(req.tenant.id).find(i => i.id === Number(invoice_id));
  if (!inv) return res.status(404).json({ error: '发票不存在' });
  if (inv.status === 'paid') return res.status(400).json({ error: '已支付' });
  payment.markInvoicePaid({ invoice_id: inv.id, out_trade_no: 'MOCK_' + inv.id, paid_at: new Date().toISOString(), payment_method: inv.payment_method });
  auth.audit(req, 'invoice_paid_mock', { target_type: 'invoice', target_id: inv.id, details: { amount: inv.amount_cny } });
  res.json({ success: true });
});

// 异步支付回调（notify_url）
app.post('/api/payment/alipay/notify', (req, res) => {
  const result = payment.verifyAlipayNotify(req.body);
  if (result.verified && (req.body.trade_status === 'TRADE_SUCCESS' || req.body.trade_status === 'TRADE_FINISHED')) {
    const inv = db.getInvoices().find(i => i.external_id === req.body.out_trade_no);
    if (inv) payment.markInvoicePaid({ invoice_id: inv.id, out_trade_no: req.body.out_trade_no, paid_at: new Date().toISOString(), payment_method: 'alipay' });
    return res.send('success');
  }
  res.send('fail');
});

app.post('/api/payment/wechat/notify', (req, res) => {
  const result = payment.verifyWechatNotify(req.headers, req.body);
  if (result.verified) {
    const inv = db.getInvoices().find(i => i.external_id === req.body.out_trade_no);
    if (inv) payment.markInvoicePaid({ invoice_id: inv.id, out_trade_no: req.body.out_trade_no, paid_at: new Date().toISOString(), payment_method: 'wechat' });
    return res.json({ code: 'SUCCESS' });
  }
  res.json({ code: 'FAIL' });
});

// ========== 租户品牌定制（owner 可改） ==========
app.get('/api/admin/branding', auth.requireAuth, (req, res) => {
  const t = db.getTenant(req.tenant.id);
  // 注：name / slug 也返回，admin 各页（特别是侧栏 logo 块）拿最新值用，
  //     不依赖 /api/auth/me 的 session 缓存（用户改完品牌要立刻见，不能要求重新登录）
  res.json({
    name: t.name || '',
    slug: t.slug || '',
    logo_url: t.logo_url || '',
    primary_color: t.primary_color || '#4f46e5'
  });
});

app.put('/api/admin/branding', auth.requireRole('owner'), upload.single('logo'), async (req, res) => {
  const t = db.getTenant(req.tenant.id);
  if (!t) return res.status(404).json({ error: '租户不存在' });
  const fields = {};
  if (req.body.primary_color) fields.primary_color = req.body.primary_color;
  if (req.file) {
    const r = await persistUpload(req.file, OSS_LOGO_PREFIX);
    fields.logo_url = r.path;
  }
  db.updateTenant(req.tenant.id, fields);
  auth.audit(req, 'update_branding', { details: { has_logo: !!req.file, primary_color: fields.primary_color } });
  const t2 = db.getTenant(req.tenant.id);
  res.json({
    name: t2.name, slug: t2.slug,
    logo_url: t2.logo_url || '', primary_color: t2.primary_color || '#4f46e5'
  });
});

// ========== Reader 端共享链接（v5：reader 端 URL 鉴权 secret） ==========
// 优先级：
//   1) env MAG_PUBLIC_BASE_URL 完整覆盖（推荐：tunnel / 反代 / 域名场景）
//   2) env MAG_PUBLIC_PORT 端口（默认 80——"标准端口"不带端口号；非 80 才显示 :port）
//   3) 兜底：用 req.host 推 proto+host，端口按 proto 80/443 判断
const READER_PUBLIC_BASE_URL = (process.env.MAG_PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const READER_PUBLIC_PORT = Number(process.env.MAG_PUBLIC_PORT || process.env.PUBLIC_PORT || 80);

function buildReaderLink(req, tenant) {
  // 1) 完整覆盖（tunnel / 反代 / 域名）
  if (READER_PUBLIC_BASE_URL) {
    return `${READER_PUBLIC_BASE_URL}/?t=${tenant.slug}&s=${tenant.reader_secret}`;
  }
  // 2) 兜底：用请求 host + 标准端口判断
  const host = (req.get('host') || '').split(':')[0] || 'localhost';
  const proto = (req.get('x-forwarded-proto') || req.protocol || 'http').split(',')[0];
  const port = READER_PUBLIC_PORT;
  const isStandardPort = (proto === 'https' && port === 443) || (proto === 'http' && port === 80);
  const portPart = isStandardPort ? '' : `:${port}`;
  return `${proto}://${host}${portPart}/?t=${tenant.slug}&s=${tenant.reader_secret}`;
}

app.get('/api/admin/tenant/reader-secret', auth.requireRole('owner'), (req, res) => {
  const t = db.getTenant(req.tenant.id);
  if (!t) return res.status(404).json({ error: '租户不存在' });
  res.json({
    secret: t.reader_secret || null,
    link: t.reader_secret ? buildReaderLink(req, t) : null,
    created_at: t.reader_secret_created_at || null,
    updated_at: t.reader_secret_updated_at || null
  });
});

app.post('/api/admin/tenant/reader-secret/regenerate', auth.requireRole('owner'), (req, res) => {
  const t = db.getTenant(req.tenant.id);
  if (!t) return res.status(404).json({ error: '租户不存在' });
  const newSecret = db.generateReaderSecret();
  const updated = db.setTenantReaderSecret(t.id, newSecret);
  auth.audit(req, 'regenerate_reader_secret', { target_type: 'tenant', target_id: t.id, details: { slug: t.slug } });
  res.json({
    secret: updated.reader_secret,
    link: buildReaderLink(req, updated),
    created_at: updated.reader_secret_created_at,
    updated_at: updated.reader_secret_updated_at
  });
});

// ========== v6.0 AI 一句话生成画册骨架 ==========
// POST /api/admin/ai/skeleton
//   auth: owner
//   body: { prompt: string (1-2000), title?: string (≤80), pageCount?: number 3..20 (default 6), locale?: 'zh-CN' (default) }
//   行为：调 MiniMax M3 → 返回 name/description/pages → 落库为 enabled=0 草稿杂志 + pageCount 个 is_skeleton page
//   失败：400 校验错 / 401 未登录 / 403 角色错 / 429 限速 / 500 LLM/落库 失败（不暴露 LLM 原始报错）
//   v6.1 增量：每租户每日 AI_DAILY_LIMIT（默认 20）次上限。超限 429 + 写 ai_rate_limited 审计。
//             mock 模式也走限速（同配额）。响应头加 X-RateLimit-Limit / -Remaining / -Reset。
const AI_DAILY_LIMIT = Math.max(1, Number(process.env.AI_DAILY_LIMIT) || 20);
const AI_DAILY_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h,每天 0 点按 UTC 对齐（与本地时区无关，行为可预测）
app.post('/api/admin/ai/skeleton', auth.requireRole('owner'), async (req, res) => {
  const body = req.body || {};
  const prompt = (body.prompt || '').toString().trim();
  const title = (body.title || '').toString().trim();
  const locale = body.locale === 'en-US' ? 'en-US' : 'zh-CN';

  // prompt 校验
  if (!prompt) return res.status(400).json({ error: 'prompt 不能为空' });
  if (prompt.length > 2000) return res.status(400).json({ error: 'prompt 超过 2000 字' });
  if (title.length > 80) return res.status(400).json({ error: 'title 不能超过 80 字' });

  // pageCount 校验
  let pageCount = 6;
  if (body.pageCount !== undefined && body.pageCount !== null && body.pageCount !== '') {
    pageCount = Number(body.pageCount);
    if (!Number.isFinite(pageCount) || !Number.isInteger(pageCount)) {
      return res.status(400).json({ error: 'pageCount 必须是整数' });
    }
    if (pageCount < 3 || pageCount > 20) {
      return res.status(400).json({ error: 'pageCount 必须在 3..20 之间' });
    }
  }

  // ============ v6.1 限速（每租户每日 N 次）============
  // 在调 LLM 之前拦截,避免产生 MiniMax API 费用
  const rl = rateLimit.checkAndIncrement(req.tenant.id, 'ai_skeleton', AI_DAILY_LIMIT, AI_DAILY_WINDOW_MS);
  const remaining = Math.max(0, rl.limit - rl.current);
  // 响应头 3 个标准字段,前端展示用
  res.setHeader('X-RateLimit-Limit', String(rl.limit));
  res.setHeader('X-RateLimit-Remaining', String(remaining));
  res.setHeader('X-RateLimit-Reset', rl.resetAt);
  if (!rl.allowed) {
    // 写 ai_rate_limited 审计（独立 action,大屏可单独计数）
    auth.audit(req, 'ai_rate_limited', {
      tenant_id: req.tenant.id,
      target_type: 'tenant',
      target_id: req.tenant.id,
      details: {
        action_blocked: 'ai_skeleton',
        limit: rl.limit,
        current: rl.current,
        reset_at: rl.resetAt,
        prompt_chars: prompt.length
      }
    });
    return res.status(429).json({
      error: `已达今日 AI 生成上限（${rl.limit} 次），明天 0 点重置`,
      current: rl.current,
      limit: rl.limit,
      resetAt: rl.resetAt
    });
  }

  // 调 LLM
  let skeleton;
  try {
    skeleton = await aiClient.generateMagazineSkeleton({ title, prompt, pageCount, locale });
  } catch (e) {
    // env 缺失的特判：给前端一个清晰的、可执行的错误
    if (!process.env.MINIMAX_API_KEY && process.env.MOCK_AI !== '1') {
      console.error('[ai-skeleton] MINIMAX_API_KEY not configured');
      return res.status(500).json({ error: 'MINIMAX_API_KEY not configured' });
    }
    console.error('[ai-skeleton] LLM call failed:', e && e.stack ? e.stack : e);
    return res.status(500).json({ error: 'AI 生成失败: ' + (e && e.message ? e.message : '未知错误') });
  }

  // 落库：先 createMagazine（enabled=0 草稿），再 addPages（is_skeleton=true）
  // 若 addPages 失败，回滚 deleteMagazine，避免孤立空壳
  const today = new Date().toISOString().slice(0, 10);
  const magazine = db.createMagazine(req.tenant.id, {
    name: skeleton.name,
    upload_date: today,
    description: skeleton.description,
    cover_pc: '',
    cover_mobile: '',
    enabled: 0
  });

  let pages;
  try {
    pages = db.addPages(req.tenant.id, magazine.id, skeleton.pages.map(p => ({
      image_path: '',          // v6.0 占位：等用户后续上传图
      title: p.title,
      body: p.body,
      is_skeleton: true
    })));
  } catch (e) {
    // 回滚：删掉空壳 magazine
    console.error('[ai-skeleton] addPages failed, rolling back magazine', magazine.id, e && e.stack ? e.stack : e);
    try { db.deleteMagazine(magazine.id, { tenantId: req.tenant.id }); }
    catch (e2) { console.error('[ai-skeleton] rollback deleteMagazine failed:', e2 && e2.message); }
    return res.status(500).json({ error: '落库失败，已回滚: ' + (e && e.message ? e.message : '未知错误') });
  }

  auth.audit(req, 'ai_generate_skeleton', {
    tenant_id: req.tenant.id,
    target_type: 'magazine',
    target_id: magazine.id,
    details: {
      page_count: pages.length,
      prompt_chars: prompt.length,
      title_overridden: !!title,
      locale,
      model: skeleton._meta.model,
      retries: skeleton._meta.retries,
      duration_ms: skeleton._meta.duration_ms,
      mock: !!skeleton._meta.mock,
      rate_remaining: remaining   // v6.1:记录调用后剩余配额,大屏可直接读 audit_log 求和
    }
  });

  res.json({
    magazine,
    pages,
    llm_meta: {
      model: skeleton._meta.model,
      duration_ms: skeleton._meta.duration_ms,
      retries: skeleton._meta.retries,
      mock: !!skeleton._meta.mock
    },
    rate_limit: {                  // v6.1:响应 body 也带,方便前端即时展示
      limit: rl.limit,
      remaining: remaining,
      reset_at: rl.resetAt
    }
  });
});

// ========== v6.2 PDF 智能解析 → 自动建画册 ==========
// POST /api/admin/magazines/import-pdf
//   auth: owner
//   body: multipart/form-data, field name = 'pdf', file = application/pdf
//   行为：multer memory 接 PDF → pdf-parser.js 抽前 N 页 PNG → 写本地 uploads/skeleton/<newId>/
//         → ai-client.analyzePdfPages({ pdfPages }) 让 LLM 给每页写 title+body
//         → createMagazine(enabled=0) + addPages（is_skeleton=true）
//         → 审计 ai_pdf_import
//   降级路径（ERR_PDF_RENDER_DEP_MISSING / ERR_PDF_RENDER_FAILED）：
//     - 不阻断 200：仍创建 enabled=0 空壳 magazine + 0 页 + warning 字段
//     - 让 owner 看到「PDF 解析失败」+ 引导手动上传图
//   限速：继承 v6.1 ai_skeleton 桶（PDF 调用算 1 次/天）
const PDF_MAX_PAGES = Math.max(1, Number(process.env.PDF_MAX_PAGES) || 30);
const PDF_MAX_FILE_BYTES = Math.max(1024 * 1024, Number(process.env.PDF_MAX_FILE_MB) * 1024 * 1024 || 60 * 1024 * 1024);  // 默认 60MB
const { parsePdfToPages, PdfRenderError } = require('./pdf-parser');

app.post('/api/admin/magazines/import-pdf', auth.requireRole('owner'), (req, res, next) => {
  // multer 单独限 PDF 大小；其它文件类型（image/jpeg 等）一律拒
  const pdfUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: PDF_MAX_FILE_BYTES, files: 1 },
    fileFilter: (req, file, cb) => {
      // 兼容：浏览器不一定给 application/pdf（macOS Safari 给 application/x-pdf 等）
      const okByMime = file.mimetype === 'application/pdf';
      const okByName = /\.pdf$/i.test(file.originalname || '');
      if (okByMime || okByName) return cb(null, true);
      cb(new Error('UNSUPPORTED_MEDIA_TYPE: 仅支持 PDF 文件'));
    }
  }).single('pdf');
  pdfUpload(req, res, (multerErr) => {
    if (multerErr) {
      if (multerErr.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'PDF 文件超过 ' + Math.round(PDF_MAX_FILE_BYTES / 1024 / 1024) + 'MB 上限' });
      }
      if (/UNSUPPORTED_MEDIA_TYPE/.test(multerErr.message)) {
        return res.status(415).json({ error: '仅支持 PDF 文件' });
      }
      return res.status(400).json({ error: '文件上传失败: ' + multerErr.message });
    }
    if (!req.file) return res.status(400).json({ error: '请上传 PDF 文件（字段名 pdf）' });

    handleImportPdf(req, res).catch(e => {
      console.error('[import-pdf] unhandled:', e && e.stack ? e.stack : e);
      res.status(500).json({ error: 'import-pdf 内部错误: ' + (e && e.message ? e.message : '未知错误') });
    });
  });
});

async function handleImportPdf(req, res) {
  const tenantId = req.tenant.id;
  const startedAt = Date.now();
  const pdfBuffer = req.file.buffer;
  const pdfSize = pdfBuffer.length;

  // ============ v6.1 限速（PDF 调用也算 ai_skeleton 一次）============
  const rl = rateLimit.checkAndIncrement(tenantId, 'ai_skeleton', AI_DAILY_LIMIT, AI_DAILY_WINDOW_MS);
  const remaining = Math.max(0, rl.limit - rl.current);
  res.setHeader('X-RateLimit-Limit', String(rl.limit));
  res.setHeader('X-RateLimit-Remaining', String(remaining));
  res.setHeader('X-RateLimit-Reset', rl.resetAt);
  if (!rl.allowed) {
    auth.audit(req, 'ai_rate_limited', {
      tenant_id: tenantId,
      target_type: 'tenant',
      target_id: tenantId,
      details: {
        action_blocked: 'import_pdf',
        limit: rl.limit,
        current: rl.current,
        reset_at: rl.resetAt,
        pdf_bytes: pdfSize
      }
    });
    return res.status(429).json({
      error: `已达今日 AI 生成上限（${rl.limit} 次），明天 0 点重置`,
      current: rl.current,
      limit: rl.limit,
      resetAt: rl.resetAt
    });
  }

  // ============ Step 1: PDF → pages（带降级）============
  let pages = [];
  let pdfParseWarning = null;
  let pdfParseDuration = 0;
  try {
    const t0 = Date.now();
    pages = await parsePdfToPages({ buffer: pdfBuffer, maxPages: PDF_MAX_PAGES });
    pdfParseDuration = Date.now() - t0;
  } catch (e) {
    pdfParseDuration = Date.now() - startedAt;
    if (e instanceof PdfRenderError && e.code === 'ERR_PDF_RENDER_DEP_MISSING') {
      // 沙箱 / 镜像漏装 canvas：把具体报错写日志 + 写 audit + 仍创建空壳 magazine
      console.warn('[import-pdf] PDF render dep missing (canvas binary not built). Returning empty draft magazine. cause:', e.message);
      pdfParseWarning = 'PDF 渲染依赖未安装（canvas native binary 缺失）；请在 Linux 镜像或装好 libpng+cairo+Python+MSVC 的 Windows 上重试，详见 README §PDF 依赖。';
    } else {
      console.error('[import-pdf] PDF parse failed:', e && e.stack ? e.stack : e);
      pdfParseWarning = 'PDF 解析失败: ' + (e && e.message ? e.message : String(e));
    }
  }

  // ============ Step 2: 准备 skeleton 目录 + 写 PNG ============
  // 先 createMagazine 拿 ID（即便后续降级也要有 magazine 落库）
  const today = new Date().toISOString().slice(0, 10);
  // 用 PDF 文件名（去扩展名）+ 日期做初始 title，AI 成功后会被覆盖
  const baseName = (req.file.originalname || '未命名 PDF')
    .replace(/\.pdf$/i, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .slice(0, 60) || '未命名 PDF';
  const initialName = baseName + '（PDF 草稿）';
  const magazine = db.createMagazine(tenantId, {
    name: initialName,
    upload_date: today,
    description: '由 PDF 智能解析自动创建（v6.2）' + (pdfParseWarning ? ' — ' + pdfParseWarning : ''),
    cover_pc: '',
    cover_mobile: '',
    enabled: 0
  });

  // 本地 skeleton 目录
  const fs = require('fs');
  const path = require('path');
  const skelDir = path.join(__dirname, '..', 'uploads', 'skeleton', String(magazine.id));
  try { fs.mkdirSync(skelDir, { recursive: true }); } catch (e) { /* best effort */ }

  const writtenPages = [];
  if (pages.length > 0) {
    for (const p of pages) {
      const filename = 'page-' + String(p.index).padStart(3, '0') + '.png';
      const filepath = path.join(skelDir, filename);
      try {
        fs.writeFileSync(filepath, p.imageBuffer);
        writtenPages.push({ index: p.index, image_path: '/uploads/skeleton/' + magazine.id + '/' + filename, mime: p.mime });
      } catch (e) {
        console.error('[import-pdf] failed to write', filepath, e.message);
      }
    }
  }

  // ============ Step 3: AI 给每页写 title+body（带降级）============
  let aiResult = null;
  let aiWarning = null;
  let aiDuration = 0;
  if (writtenPages.length > 0) {
    try {
      const t0 = Date.now();
      aiResult = await aiClient.analyzePdfPages({
        pdfPages: writtenPages.map(p => ({ page_index: p.index, image_path: p.image_path, mime: p.mime })),
        locale: 'zh-CN',
        topic: ''  // v6.2 不强制主题；让 LLM 自由发挥
      });
      aiDuration = Date.now() - t0;
    } catch (e) {
      console.error('[import-pdf] analyzePdfPages failed:', e && e.stack ? e.stack : e);
      aiWarning = 'AI 分析失败: ' + (e && e.message ? e.message : String(e));
    }
  }

  // ============ Step 4: 用 AI 结果回填 title/body，addPages 落库 ============
  // 把 aiResult.pages（[{page_index, title, body}]）映射回 writtenPages（按 page_index 对齐）
  const titleByIndex = new Map();
  if (aiResult && Array.isArray(aiResult.pages)) {
    for (const ap of aiResult.pages) {
      if (ap && typeof ap.page_index === 'number') titleByIndex.set(ap.page_index, ap);
    }
  }
  // 1) 更新 magazine.name / description（用第一页的 title + 一段说明）
  if (aiResult && aiResult.pages.length > 0) {
    const first = aiResult.pages[0];
    if (first && first.title) {
      magazine.name = first.title + (writtenPages.length > 1 ? '（' + writtenPages.length + ' 页）' : '');
      magazine.description = '由 PDF 智能解析自动创建（v6.2，' + (aiResult._meta.mock ? 'mock' : 'MiniMax-M3') + '）';
      db.updateMagazine(magazine.id, { name: magazine.name, description: magazine.description }, { tenantId });
    }
  }

  // 2) addPages（如果有解析出来的页）
  let savedPages = [];
  if (writtenPages.length > 0) {
    const pageInputs = writtenPages.map(wp => {
      const ai = titleByIndex.get(wp.index);
      return {
        image_path: wp.image_path,
        title: (ai && ai.title) ? ai.title : ('第 ' + wp.index + ' 页'),
        body: (ai && ai.body) ? ai.body : '',
        is_skeleton: true
      };
    });
    try {
      savedPages = db.addPages(tenantId, magazine.id, pageInputs);
    } catch (e) {
      console.error('[import-pdf] addPages failed, rolling back magazine', magazine.id, e && e.stack ? e.stack : e);
      try { db.deleteMagazine(magazine.id, { tenantId }); } catch (e2) { console.error('[import-pdf] rollback deleteMagazine failed:', e2 && e2.message); }
      // 清理 skeleton 目录
      try { fs.rmSync(skelDir, { recursive: true, force: true }); } catch (_) {}
      return res.status(500).json({ error: '落库失败，已回滚: ' + (e && e.message ? e.message : '未知错误') });
    }
  }

  const totalDuration = Date.now() - startedAt;

  // ============ Step 5: 审计 ============
  auth.audit(req, 'ai_pdf_import', {
    tenant_id: tenantId,
    target_type: 'magazine',
    target_id: magazine.id,
    details: {
      pdf_bytes: pdfSize,
      pdf_filename: req.file.originalname,
      pdf_pages_count: writtenPages.length,
      pdf_max_pages: PDF_MAX_PAGES,
      pdf_parse_warning: pdfParseWarning,
      ai_model: aiResult ? aiResult._meta.model : null,
      ai_retries: aiResult ? aiResult._meta.retries : null,
      ai_warning: aiWarning,
      ai_duration_ms: aiDuration,
      pdf_parse_duration_ms: pdfParseDuration,
      total_duration_ms: totalDuration,
      mock: aiResult ? !!aiResult._meta.mock : null,
      rate_remaining: remaining
    }
  });

  // 警告合并
  const warnings = [pdfParseWarning, aiWarning].filter(Boolean);

  res.json({
    magazine: db.getMagazine(magazine.id, { tenantId }),
    pages: savedPages,
    pdf_meta: {
      filename: req.file.originalname,
      bytes: pdfSize,
      pages_extracted: writtenPages.length,
      max_pages: PDF_MAX_PAGES,
      parse_duration_ms: pdfParseDuration
    },
    llm_meta: aiResult ? {
      model: aiResult._meta.model,
      duration_ms: aiResult._meta.duration_ms,
      retries: aiResult._meta.retries,
      mock: !!aiResult._meta.mock
    } : null,
    rate_limit: {
      limit: rl.limit,
      remaining: remaining,
      reset_at: rl.resetAt
    },
    warning: warnings.length ? warnings.join(' | ') : null
  });
}

// ========== Reader 端分析（看板） ==========
app.get('/api/admin/analytics', auth.requireAuth, (req, res) => {
  const since = req.query.since || new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const stats = db.getReaderStats({ tenantId: req.tenant.id, since });
  const byMag = db.getReaderStatsByMagazine(req.tenant.id, since);
  res.json({ summary: { total_views: stats.total_views, unique_viewers: stats.unique_viewers, completes: stats.completes, avg_dwell_ms: stats.avg_dwell_ms }, by_magazine: byMag, since });
});

// ========== v6.1 AI 调用大屏（owner/editor 都能看） ==========
// GET /api/admin/ai-stats?since=ISO&until=ISO
//   auth: requireAuth（owner 和 editor 都可看，按租户隔离）
//   默认 since = 7 天前，until = 现在
//   返回：
//     {
//       summary: { total, success, failed, rate_limited, avg_duration_ms, p95_duration_ms, success_rate },
//       trend:   [{ bucket: ISO, total, success, failed, rate_limited }]   // 按天 UTC 对齐
//       top_failures: [{ error, count }]   // 失败 Top 5（依赖上游失败审计；v6.0 失败分支不写 audit 时为空）
//       quota:   { current, limit, reset_at }                             // 今日剩余配额（in-memory rate-limit）
//       since, until
//     }
//   失败：401 / 403 / 500（极少）
app.get('/api/admin/ai-stats', auth.requireAuth, (req, res) => {
  try {
    const now = Date.now();
    const since = req.query.since || new Date(now - 7 * 24 * 3600 * 1000).toISOString();
    const until = req.query.until || new Date(now).toISOString();
    const tenantId = req.tenant.id;

    const stats = db.getAiCallStats({ tenantId, since, until });
    // 加 success_rate 给前端展示百分比（保留 1 位小数）
    const successRate = stats.total > 0
      ? Math.round((stats.success / stats.total) * 1000) / 10
      : 0;

    const trend = db.getAiCallTrend({ tenantId, since, until });
    const topFailures = db.getAiCallTopFailures({ tenantId, since, until, limit: 5 });

    // 今日配额（v6.1 限速器在内存中；进程重启会清空，回 0）
    const rl = rateLimit.peek(tenantId, 'ai_skeleton', AI_DAILY_LIMIT, AI_DAILY_WINDOW_MS);

    res.json({
      summary: {
        total: stats.total,
        success: stats.success,
        failed: stats.failed,
        rate_limited: stats.rate_limited,
        avg_duration_ms: stats.avg_duration_ms,
        p95_duration_ms: stats.p95_duration_ms,
        success_rate: successRate
      },
      trend,
      top_failures: topFailures,
      quota: {
        current: rl.current,
        limit: rl.limit,
        reset_at: rl.resetAt
      },
      since,
      until
    });
  } catch (e) {
    console.error('[ai-stats] failed:', e && e.stack ? e.stack : e);
    res.status(500).json({ error: 'AI 统计查询失败: ' + (e && e.message ? e.message : '未知错误') });
  }
});

// ========== Email log（platform_admin 看） ==========
app.get('/api/admin/email-log', auth.requirePlatformAdmin, (req, res) => {
  const { to_email, status, limit, offset } = req.query;
  res.json(db.getEmailLog({
    to_email, status,
    limit: Math.min(Number(limit) || 100, 500),
    offset: Number(offset) || 0
  }));
});

// ========== 杂志/页/封面 CRUD（v3 已有，按 role 检查） ==========
app.get('/api/magazines', auth.requireAuth, (req, res) => {
  const { search, enabled, tenantId: queryTenantId } = req.query;
  let effectiveTenantId = req.tenant.id;
  if (req.tenant.is_platform_admin && queryTenantId) effectiveTenantId = Number(queryTenantId);
  res.json(db.getAllMagazines({ tenantId: effectiveTenantId, search, enabled }));
});

app.get('/api/magazines/:id', auth.requireAuth, (req, res) => {
  const tenantId = req.tenant.is_platform_admin ? undefined : req.tenant.id;
  const magazine = db.getMagazine(req.params.id, { tenantId });
  if (!magazine) return res.status(404).json({ error: '杂志不存在' });
  const pages = db.getPages(req.params.id, { tenantId });
  res.json({ ...magazine, pages });
});

app.post('/api/magazines', auth.requireRole('owner', 'editor'), (req, res) => {
  const { name, upload_date, description, cover_pc, cover_mobile } = req.body;
  if (!name || !upload_date) return res.status(400).json({ error: '名称和日期必填' });
  const mag = db.createMagazine(req.tenant.id, { name, upload_date, description, cover_pc, cover_mobile });
  auth.audit(req, 'create_magazine', { target_type: 'magazine', target_id: mag.id, details: { name } });
  res.json(mag);
});

app.put('/api/magazines/:id', auth.requireRole('owner', 'editor'), (req, res) => {
  const tenantId = req.tenant.is_platform_admin ? undefined : req.tenant.id;
  const before = db.getMagazine(req.params.id, { tenantId });
  const updated = db.updateMagazine(req.params.id, req.body, { tenantId });
  if (!updated) return res.status(404).json({ error: '杂志不存在' });
  auth.audit(req, 'update_magazine', { tenant_id: updated.tenant_id, target_type: 'magazine', target_id: updated.id, details: { changed: Object.keys(req.body) } });
  res.json(updated);
});

app.delete('/api/magazines/:id', auth.requireRole('owner', 'editor'), (req, res) => {
  const tenantId = req.tenant.is_platform_admin ? undefined : req.tenant.id;
  const before = db.getMagazine(req.params.id, { tenantId });
  const ok = db.deleteMagazine(req.params.id, { tenantId });
  if (!ok) return res.status(404).json({ error: '杂志不存在' });
  auth.audit(req, 'delete_magazine', { tenant_id: before ? before.tenant_id : null, target_type: 'magazine', target_id: Number(req.params.id), details: { name: before && before.name } });
  res.json({ success: true });
});

app.post('/api/magazines/:id/pages', auth.requireRole('owner', 'editor'), upload.single('image'), async (req, res) => {
  const tenantId = req.tenant.is_platform_admin ? undefined : req.tenant.id;
  const magazine = db.getMagazine(req.params.id, { tenantId });
  if (!magazine) return res.status(404).json({ error: '杂志不存在' });
  if (!req.file) return res.status(400).json({ error: '请上传图片' });
  try {
    const r = await persistUpload(req.file);
    const page = db.addPage(magazine.tenant_id, req.params.id, r.path);
    auth.audit(req, 'add_page', { tenant_id: magazine.tenant_id, target_type: 'page', target_id: page.id, details: { magazine_id: magazine.id, magazine_name: magazine.name } });
    res.json(page);
  } catch (err) { res.status(500).json({ error: 'OSS 上传失败: ' + err.message }); }
});

app.post('/api/magazines/:id/pages/batch', auth.requireRole('owner', 'editor'), upload.array('images', 50), async (req, res) => {
  const tenantId = req.tenant.is_platform_admin ? undefined : req.tenant.id;
  const magazine = db.getMagazine(req.params.id, { tenantId });
  if (!magazine) return res.status(404).json({ error: '杂志不存在' });
  if (!req.files || !req.files.length) return res.status(400).json({ error: '请上传图片' });
  try {
    const results = await Promise.all(req.files.map(f => persistUpload(f)));
    const newPages = db.addPages(magazine.tenant_id, req.params.id, results.map(r => r.path));
    auth.audit(req, 'add_pages_batch', { tenant_id: magazine.tenant_id, target_type: 'magazine', target_id: magazine.id, details: { magazine_name: magazine.name, count: newPages.length } });
    res.json(newPages);
  } catch (err) { res.status(500).json({ error: 'OSS 批量上传失败: ' + err.message }); }
});

app.put('/api/magazines/:id/pages/reorder', auth.requireRole('owner', 'editor'), (req, res) => {
  const tenantId = req.tenant.is_platform_admin ? undefined : req.tenant.id;
  const { orderedIds } = req.body;
  if (!Array.isArray(orderedIds)) return res.status(400).json({ error: 'orderedIds 必须是数组' });
  const magazine = db.getMagazine(req.params.id, { tenantId });
  if (!magazine) return res.status(404).json({ error: '杂志不存在' });
  db.reorderPages(req.params.id, orderedIds, { tenantId });
  auth.audit(req, 'reorder_pages', { tenant_id: magazine.tenant_id, target_type: 'magazine', target_id: magazine.id, details: { count: orderedIds.length } });
  res.json({ success: true });
});

app.delete('/api/magazines/:id/pages/:pageId', auth.requireRole('owner', 'editor'), (req, res) => {
  const tenantId = req.tenant.is_platform_admin ? undefined : req.tenant.id;
  const magazine = db.getMagazine(req.params.id, { tenantId });
  if (!magazine) return res.status(404).json({ error: '杂志不存在' });
  const ok = db.deletePage(req.params.id, req.params.pageId, { tenantId });
  if (!ok) return res.status(404).json({ error: '页面不存在' });
  auth.audit(req, 'delete_page', { tenant_id: magazine.tenant_id, target_type: 'page', target_id: Number(req.params.pageId) });
  res.json({ success: true });
});

app.post('/api/covers/upload', auth.requireRole('owner', 'editor'), upload.single('image'), async (req, res) => {
  const { magazine_id, type } = req.body;
  if (!req.file) return res.status(400).json({ error: '请上传图片' });
  if (!['pc', 'mobile'].includes(type)) return res.status(400).json({ error: 'type 必须是 pc 或 mobile' });
  try {
    const r = await persistUpload(req.file);
    const cover = db.createCover(req.tenant.id, { magazine_id: magazine_id || null, type, image_path: r.path });
    auth.audit(req, 'create_cover', { target_type: 'cover', target_id: cover.id, details: { type, magazine_id } });
    res.json(cover);
  } catch (err) { res.status(500).json({ error: 'OSS 封面上传失败: ' + err.message }); }
});

app.get('/api/covers', auth.requireAuth, (req, res) => {
  const { magazine_id, tenantId: queryTenantId } = req.query;
  let effectiveTenantId = req.tenant.id;
  if (req.tenant.is_platform_admin && queryTenantId) effectiveTenantId = Number(queryTenantId);
  res.json(db.getAllCovers({ tenantId: effectiveTenantId, magazine_id }));
});

app.delete('/api/covers/:id', auth.requireRole('owner', 'editor'), (req, res) => {
  const tenantId = req.tenant.is_platform_admin ? undefined : req.tenant.id;
  const all = db.getAllCovers({ tenantId });
  const cover = all.find(c => c.id === Number(req.params.id));
  const ok = db.deleteCover(req.params.id, { tenantId });
  if (!ok) return res.status(404).json({ error: '封面不存在' });
  auth.audit(req, 'delete_cover', { tenant_id: cover ? cover.tenant_id : null, target_type: 'cover', target_id: Number(req.params.id) });
  res.json({ success: true });
});

app.post('/api/upload', auth.requireRole('owner', 'editor'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请上传文件' });
  try {
    const r = await persistUpload(req.file);
    auth.audit(req, 'upload_file', { target_type: 'file', target_id: 0, details: { filename: r.filename } });
    res.json(r);
  } catch (err) { res.status(500).json({ error: 'OSS 上传失败: ' + err.message }); }
});

// ========== Publish（保留 v3 逻辑） ==========
app.post('/api/admin/publish', auth.requireAuth, async (req, res) => {
  if (!ossClient) return res.status(500).json({ error: 'OSS 未配置' });
  const snapshot = db.snapshotForPublish();
  const json = JSON.stringify(snapshot);
  try {
    const result = await ossClient.put(OSS_PUBLISH_KEY, Buffer.from(json, 'utf8'), {
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${OSS_PUBLISH_TTL_S}` }
    });
    auth.audit(req, 'publish', { details: { bytes: json.length, counts: { tenants: snapshot.tenants.length, magazines: snapshot.magazines.length, pages: snapshot.pages.length, covers: snapshot.covers.length } } });
    res.json({ success: true, url: result.url, bytes: json.length, counts: { tenants: snapshot.tenants.length, magazines: snapshot.magazines.length, pages: snapshot.pages.length, covers: snapshot.covers.length } });
  } catch (err) { res.status(500).json({ error: 'Publish 失败: ' + err.message }); }
});

module.exports = app;
