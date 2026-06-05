// 管理后台（默认 port 50040，可由 ADMIN_PORT env 覆盖）：CRUD + 上传 + 排序 + 封面管理 + 鉴权 + publish + 平台管理 + 审计日志
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const OSS = require('ali-oss');
const db = require('./db/init');
const auth = require('./auth');

const app = express();
app.set('trust proxy', true);  // 让 req.ip 在反代后面也能拿到真实 IP
app.use(cors());
app.use(express.json());

// 静态资源：admin/ + /uploads（管理端要展示已上传的封面）
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));
app.get('/', (req, res) => res.redirect('/admin/'));

// 解析 session（所有路由都能拿到 req.tenant）
app.use(auth.attachSession);

// 上传配置
const dbDir = path.join(__dirname, '..', 'db');
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

// OSS 客户端（凭证从 .env 读）
let ossClient = null;
if (process.env.OSS_ACCESS_KEY_ID && process.env.OSS_ACCESS_KEY_SECRET) {
  ossClient = new OSS({
    region: process.env.OSS_REGION || 'oss-cn-beijing',
    accessKeyId: process.env.OSS_ACCESS_KEY_ID,
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
    bucket: process.env.OSS_BUCKET || 'openclawbsf',
    secure: true
  });
  console.log('[oss] client ready, bucket=' + (process.env.OSS_BUCKET || 'openclawbsf') + ' prefix=' + (process.env.OSS_PREFIX || 'magazine-admin/covers/'));
} else {
  console.warn('[oss] credentials not set in .env — uploads will fall back to local /uploads/');
}

const OSS_PREFIX = process.env.OSS_PREFIX || 'magazine-admin/covers/';
const OSS_PUBLISH_KEY = 'magazine-admin/data.json';  // publish 目标 key
const OSS_PUBLISH_TTL_S = 300;  // 公共 data.json 缓存 5 分钟

// 内存存储：上传时不落本地，直接 buffer 推到 OSS
const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

// 通用 helper：推文件到 OSS（或 fallback 到本地）
async function persistUpload(file) {
  const ext = path.extname(file.originalname) || '.bin';
  const randomName = Date.now() + '-' + Math.round(Math.random() * 1e9) + ext;
  if (ossClient) {
    const key = OSS_PREFIX + randomName;
    const result = await ossClient.put(key, file.buffer, {
      headers: { 'Cache-Control': 'public, max-age=31536000' }
    });
    return { path: result.url, filename: randomName, ossKey: key };
  }
  const dst = path.join(__dirname, '..', 'uploads', randomName);
  fs.writeFileSync(dst, file.buffer);
  return { path: '/uploads/' + randomName, filename: randomName };
}

// audit log 工具：从 req 取 actor 信息，写一行 log
function audit(req, action, opts) {
  if (!req.session) return;
  const actor = {
    actor_tenant_id: req.session.tenantId,
    actor_tenant_slug: req.session.slug,
    actor_is_platform_admin: !!req.session.isPlatformAdmin
  };
  const entry = Object.assign({
    tenant_id: req.tenant ? req.tenant.id : null,
    action,
    ip: req.ip,
    user_agent: req.headers && req.headers['user-agent']
  }, actor, opts || {});
  db.addAuditLog(entry);
}

// ========== Auth ==========
app.post('/api/auth/login', (req, res) => {
  const { slug, password } = req.body || {};
  if (!slug || !password) return res.status(400).json({ error: 'slug 和 password 必填' });
  const result = auth.login(slug, password, req);
  if (!result.ok) return res.status(401).json({ error: result.error });
  auth.setSessionCookie(res, result.sid);
  res.json({ success: true, tenant: result.tenant });
});

app.post('/api/auth/logout', (req, res) => {
  auth.logout(req);
  auth.clearSessionCookie(res);
  res.json({ success: true });
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session) return res.status(401).json({ error: '未登录', code: 'AUTH_REQUIRED' });
  res.json({ tenant: req.tenant });
});

// ========== 平台管理：租户 CRUD（仅 platform_admin） ==========
app.get('/api/admin/tenants', auth.requirePlatformAdmin, (req, res) => {
  const tenants = db.getAllTenants().map(t => {
    const usage = db.getTenantUsage(t.id);
    return {
      id: t.id,
      slug: t.slug,
      name: t.name,
      is_platform_admin: !!t.is_platform_admin,
      suspended: !!t.suspended,
      has_password: !!t.password,
      created_at: t.created_at,
      usage
    };
  });
  res.json(tenants);
});

app.post('/api/admin/tenants', auth.requirePlatformAdmin, (req, res) => {
  const { slug, name, password, is_platform_admin } = req.body || {};
  if (!slug || !name) return res.status(400).json({ error: 'slug 和 name 必填' });
  if (!/^[a-z0-9-]{2,32}$/.test(slug)) {
    return res.status(400).json({ error: 'slug 只能包含小写字母、数字、连字符，长度 2-32' });
  }
  try {
    const tenant = db.createTenant({
      slug, name,
      password: password || '',
      is_platform_admin: !!is_platform_admin
    });
    audit(req, 'create_tenant', {
      tenant_id: tenant.id,
      target_type: 'tenant',
      target_id: tenant.id,
      details: { slug, name, is_platform_admin: !!is_platform_admin }
    });
    res.json({
      id: tenant.id, slug: tenant.slug, name: tenant.name,
      is_platform_admin: tenant.is_platform_admin,
      suspended: tenant.suspended,
      created_at: tenant.created_at
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/admin/tenants/:id', auth.requirePlatformAdmin, (req, res) => {
  const { name, password, is_platform_admin } = req.body || {};
  const fields = {};
  if (name !== undefined) fields.name = name;
  if (password !== undefined) fields.password = password;  // 允许空密码 = 清空
  if (is_platform_admin !== undefined) fields.is_platform_admin = !!is_platform_admin;
  const tenant = db.updateTenant(req.params.id, fields);
  if (!tenant) return res.status(404).json({ error: '租户不存在' });
  audit(req, 'update_tenant', {
    target_type: 'tenant',
    target_id: tenant.id,
    details: Object.keys(fields)
  });
  res.json({
    id: tenant.id, slug: tenant.slug, name: tenant.name,
    is_platform_admin: tenant.is_platform_admin,
    suspended: tenant.suspended,
    created_at: tenant.created_at
  });
});

app.post('/api/admin/tenants/:id/suspend', auth.requirePlatformAdmin, (req, res) => {
  const tenant = db.getTenant(req.params.id);
  if (!tenant) return res.status(404).json({ error: '租户不存在' });
  if (tenant.is_platform_admin) return res.status(400).json({ error: '不能暂停平台管理员租户' });
  db.setTenantSuspended(req.params.id, true);
  audit(req, 'suspend_tenant', { target_type: 'tenant', target_id: tenant.id });
  res.json({ success: true });
});

app.post('/api/admin/tenants/:id/unsuspend', auth.requirePlatformAdmin, (req, res) => {
  const tenant = db.getTenant(req.params.id);
  if (!tenant) return res.status(404).json({ error: '租户不存在' });
  db.setTenantSuspended(req.params.id, false);
  audit(req, 'unsuspend_tenant', { target_type: 'tenant', target_id: tenant.id });
  res.json({ success: true });
});

app.delete('/api/admin/tenants/:id', auth.requirePlatformAdmin, (req, res) => {
  const tenant = db.getTenant(req.params.id);
  if (!tenant) return res.status(404).json({ error: '租户不存在' });
  if (tenant.is_platform_admin) return res.status(400).json({ error: '不能删除平台管理员租户' });
  // 先记 audit（因为删了之后日志也跟着没，但 tenant_id 还在 audit_log 自己的字段里）
  audit(req, 'delete_tenant', {
    target_type: 'tenant',
    target_id: tenant.id,
    details: { slug: tenant.slug, name: tenant.name }
  });
  db.deleteTenant(req.params.id);
  res.json({ success: true });
});

// ========== 审计日志（仅 platform_admin） ==========
app.get('/api/admin/audit-logs', auth.requirePlatformAdmin, (req, res) => {
  const { tenantId, actorTenantId, action, limit, offset } = req.query;
  const result = db.getAuditLogs({
    tenantId: tenantId !== undefined ? Number(tenantId) : undefined,
    actorTenantId: actorTenantId !== undefined ? Number(actorTenantId) : undefined,
    action,
    limit: Math.min(Number(limit) || 200, 1000),
    offset: Number(offset) || 0
  });
  res.json(result);
});

// ========== Magazines（管理用） ==========
app.get('/api/magazines', auth.requireAuth, (req, res) => {
  // 平台管理员可选 ?tenantId= 看特定租户；非平台管理员只能看自己
  const isPlatformAdmin = req.tenant && req.tenant.is_platform_admin;
  const { search, enabled, tenantId: queryTenantId } = req.query;
  let effectiveTenantId = req.tenant.id;
  if (isPlatformAdmin && queryTenantId) {
    effectiveTenantId = Number(queryTenantId);
  }
  res.json(db.getAllMagazines({ tenantId: effectiveTenantId, search, enabled }));
});

app.get('/api/magazines/:id', auth.requireAuth, (req, res) => {
  const isPlatformAdmin = req.tenant && req.tenant.is_platform_admin;
  const tenantId = isPlatformAdmin ? undefined : req.tenant.id;
  const magazine = db.getMagazine(req.params.id, { tenantId });
  if (!magazine) return res.status(404).json({ error: '杂志不存在' });
  const pages = db.getPages(req.params.id, { tenantId });
  res.json({ ...magazine, pages });
});

app.post('/api/magazines', auth.requireAuth, (req, res) => {
  const { name, upload_date, description, cover_pc, cover_mobile } = req.body;
  if (!name || !upload_date) return res.status(400).json({ error: '名称和日期必填' });
  const mag = db.createMagazine(req.tenant.id, { name, upload_date, description, cover_pc, cover_mobile });
  audit(req, 'create_magazine', {
    target_type: 'magazine',
    target_id: mag.id,
    details: { name }
  });
  res.json(mag);
});

app.put('/api/magazines/:id', auth.requireAuth, (req, res) => {
  const isPlatformAdmin = req.tenant && req.tenant.is_platform_admin;
  const tenantId = isPlatformAdmin ? undefined : req.tenant.id;
  const { name, upload_date, description, cover_pc, cover_mobile, enabled } = req.body;
  const before = db.getMagazine(req.params.id, { tenantId });
  const updated = db.updateMagazine(req.params.id,
    { name, upload_date, description, cover_pc, cover_mobile, enabled },
    { tenantId }
  );
  if (!updated) return res.status(404).json({ error: '杂志不存在' });
  audit(req, 'update_magazine', {
    tenant_id: updated.tenant_id,
    target_type: 'magazine',
    target_id: updated.id,
    details: { changed_fields: Object.keys(req.body).filter(k => k !== 'id') }
  });
  res.json(updated);
});

app.delete('/api/magazines/:id', auth.requireAuth, (req, res) => {
  const isPlatformAdmin = req.tenant && req.tenant.is_platform_admin;
  const tenantId = isPlatformAdmin ? undefined : req.tenant.id;
  const before = db.getMagazine(req.params.id, { tenantId });
  const ok = db.deleteMagazine(req.params.id, { tenantId });
  if (!ok) return res.status(404).json({ error: '杂志不存在' });
  audit(req, 'delete_magazine', {
    tenant_id: before ? before.tenant_id : null,
    target_type: 'magazine',
    target_id: Number(req.params.id),
    details: { name: before && before.name }
  });
  res.json({ success: true });
});

// ========== Pages ==========
app.post('/api/magazines/:id/pages', auth.requireAuth, upload.single('image'), async (req, res) => {
  const isPlatformAdmin = req.tenant && req.tenant.is_platform_admin;
  const tenantId = isPlatformAdmin ? undefined : req.tenant.id;
  const magazine = db.getMagazine(req.params.id, { tenantId });
  if (!magazine) return res.status(404).json({ error: '杂志不存在' });
  if (!req.file) return res.status(400).json({ error: '请上传图片' });
  try {
    const r = await persistUpload(req.file);
    const page = db.addPage(magazine.tenant_id, req.params.id, r.path);
    audit(req, 'add_page', {
      tenant_id: magazine.tenant_id,
      target_type: 'page',
      target_id: page.id,
      details: { magazine_id: magazine.id, magazine_name: magazine.name }
    });
    res.json(page);
  } catch (err) { res.status(500).json({ error: 'OSS 上传失败: ' + err.message }); }
});

app.post('/api/magazines/:id/pages/batch', auth.requireAuth, upload.array('images', 50), async (req, res) => {
  const isPlatformAdmin = req.tenant && req.tenant.is_platform_admin;
  const tenantId = isPlatformAdmin ? undefined : req.tenant.id;
  const magazine = db.getMagazine(req.params.id, { tenantId });
  if (!magazine) return res.status(404).json({ error: '杂志不存在' });
  if (!req.files || !req.files.length) return res.status(400).json({ error: '请上传图片' });
  try {
    const results = await Promise.all(req.files.map(persistUpload));
    const newPages = db.addPages(magazine.tenant_id, req.params.id, results.map(r => r.path));
    audit(req, 'add_pages_batch', {
      tenant_id: magazine.tenant_id,
      target_type: 'magazine',
      target_id: magazine.id,
      details: { magazine_name: magazine.name, count: newPages.length }
    });
    res.json(newPages);
  } catch (err) { res.status(500).json({ error: 'OSS 批量上传失败: ' + err.message }); }
});

app.put('/api/magazines/:id/pages/reorder', auth.requireAuth, (req, res) => {
  const isPlatformAdmin = req.tenant && req.tenant.is_platform_admin;
  const tenantId = isPlatformAdmin ? undefined : req.tenant.id;
  const { orderedIds } = req.body;
  if (!Array.isArray(orderedIds)) return res.status(400).json({ error: 'orderedIds 必须是数组' });
  const magazine = db.getMagazine(req.params.id, { tenantId });
  if (!magazine) return res.status(404).json({ error: '杂志不存在' });
  db.reorderPages(req.params.id, orderedIds, { tenantId });
  audit(req, 'reorder_pages', {
    tenant_id: magazine.tenant_id,
    target_type: 'magazine',
    target_id: magazine.id,
    details: { count: orderedIds.length }
  });
  res.json({ success: true });
});

app.delete('/api/magazines/:id/pages/:pageId', auth.requireAuth, (req, res) => {
  const isPlatformAdmin = req.tenant && req.tenant.is_platform_admin;
  const tenantId = isPlatformAdmin ? undefined : req.tenant.id;
  const magazine = db.getMagazine(req.params.id, { tenantId });
  if (!magazine) return res.status(404).json({ error: '杂志不存在' });
  const ok = db.deletePage(req.params.id, req.params.pageId, { tenantId });
  if (!ok) return res.status(404).json({ error: '页面不存在' });
  audit(req, 'delete_page', {
    tenant_id: magazine.tenant_id,
    target_type: 'page',
    target_id: Number(req.params.pageId),
    details: { magazine_id: magazine.id, magazine_name: magazine.name }
  });
  res.json({ success: true });
});

// ========== Covers ==========
app.post('/api/covers/upload', auth.requireAuth, upload.single('image'), async (req, res) => {
  const isPlatformAdmin = req.tenant && req.tenant.is_platform_admin;
  const tenantId = isPlatformAdmin ? undefined : req.tenant.id;
  const { magazine_id, type } = req.body;
  if (!req.file) return res.status(400).json({ error: '请上传图片' });
  if (!['pc', 'mobile'].includes(type)) return res.status(400).json({ error: 'type 必须是 pc 或 mobile' });
  if (magazine_id) {
    const m = db.getMagazine(magazine_id, { tenantId });
    if (!m) return res.status(404).json({ error: '杂志不存在' });
  }
  try {
    const r = await persistUpload(req.file);
    // 写入用 admin 自己的 tenant_id（不是 magazine 的），保证数据归属
    const cover = db.createCover(req.tenant.id, { magazine_id: magazine_id || null, type, image_path: r.path });
    audit(req, 'create_cover', {
      tenant_id: req.tenant.id,
      target_type: 'cover',
      target_id: cover.id,
      details: { type, magazine_id: magazine_id || null }
    });
    res.json(cover);
  } catch (err) { res.status(500).json({ error: 'OSS 封面上传失败: ' + err.message }); }
});

app.get('/api/covers', auth.requireAuth, (req, res) => {
  const isPlatformAdmin = req.tenant && req.tenant.is_platform_admin;
  const { magazine_id, tenantId: queryTenantId } = req.query;
  let effectiveTenantId = req.tenant.id;
  if (isPlatformAdmin && queryTenantId) {
    effectiveTenantId = Number(queryTenantId);
  }
  res.json(db.getAllCovers({ tenantId: effectiveTenantId, magazine_id }));
});

app.delete('/api/covers/:id', auth.requireAuth, (req, res) => {
  const isPlatformAdmin = req.tenant && req.tenant.is_platform_admin;
  const tenantId = isPlatformAdmin ? undefined : req.tenant.id;
  const all = db.getAllCovers({ tenantId });
  const cover = all.find(c => c.id === Number(req.params.id));
  const ok = db.deleteCover(req.params.id, { tenantId });
  if (!ok) return res.status(404).json({ error: '封面不存在' });
  audit(req, 'delete_cover', {
    tenant_id: cover ? cover.tenant_id : null,
    target_type: 'cover',
    target_id: Number(req.params.id),
    details: { type: cover && cover.type }
  });
  res.json({ success: true });
});

// 通用文件上传
app.post('/api/upload', auth.requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请上传文件' });
  try {
    const r = await persistUpload(req.file);
    audit(req, 'upload_file', {
      target_type: 'file',
      target_id: 0,
      details: { filename: r.filename, ossKey: r.ossKey }
    });
    res.json(r);
  } catch (err) { res.status(500).json({ error: 'OSS 上传失败: ' + err.message }); }
});

// ========== Publish (SaaS 模式下已不常用，留作可选缓存层) ==========
// SaaS 模式：阅读端默认走同源 /api/public/data 拿 live 数据，不需 publish。
// 仍保留这个端点以便需要 CDN 加速 / 跨域静态部署时手动触发：
//   1. 把 data 快照推到 OSS
//   2. 阅读端 config.js 把 DATA_URL 指向 OSS URL
//   3. 阅读端就改读 CDN（带 5min 缓存）
app.post('/api/admin/publish', auth.requireAuth, async (req, res) => {
  if (!ossClient) {
    return res.status(500).json({ error: 'OSS 未配置，无法 publish' });
  }
  const snapshot = db.snapshotForPublish();
  const json = JSON.stringify(snapshot);
  try {
    const result = await ossClient.put(OSS_PUBLISH_KEY, Buffer.from(json, 'utf8'), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': `public, max-age=${OSS_PUBLISH_TTL_S}`
      }
    });
    audit(req, 'publish', { details: { bytes: json.length, counts: {
      tenants: snapshot.tenants.length, magazines: snapshot.magazines.length,
      pages: snapshot.pages.length, covers: snapshot.covers.length
    }}});
    res.json({
      success: true,
      url: result.url,
      bytes: json.length,
      counts: {
        tenants: snapshot.tenants.length,
        magazines: snapshot.magazines.length,
        pages: snapshot.pages.length,
        covers: snapshot.covers.length
      }
    });
  } catch (err) {
    console.error('[publish] failed:', err);
    res.status(500).json({ error: 'Publish 失败: ' + err.message });
  }
});

module.exports = app;
