// 管理后台（默认 port 50030，可由 ADMIN_PORT env 覆盖）：CRUD + 上传 + 排序 + 封面管理 + 鉴权 + publish
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
  // Fallback：本地
  const dst = path.join(__dirname, '..', 'uploads', randomName);
  fs.writeFileSync(dst, file.buffer);
  return { path: '/uploads/' + randomName, filename: randomName };
}

// ========== Auth ==========
app.post('/api/auth/login', (req, res) => {
  const { slug, password } = req.body || {};
  if (!slug || !password) return res.status(400).json({ error: 'slug 和 password 必填' });
  const result = auth.login(slug, password);
  if (!result.ok) return res.status(401).json({ error: result.error });
  auth.setSessionCookie(res, result.sid);
  res.json({ success: true, tenant: result.tenant });
});

app.post('/api/auth/logout', (req, res) => {
  auth.destroySession(req.sid);
  auth.clearSessionCookie(res);
  res.json({ success: true });
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session) return res.status(401).json({ error: '未登录', code: 'AUTH_REQUIRED' });
  res.json({ tenant: req.tenant });
});

// ========== Magazines（管理用） ==========
app.get('/api/magazines', auth.requireAuth, (req, res) => {
  const { search, enabled } = req.query;
  res.json(db.getAllMagazines({ tenantId: req.tenant.id, search, enabled }));
});

app.get('/api/magazines/:id', auth.requireAuth, (req, res) => {
  const magazine = db.getMagazine(req.params.id, { tenantId: req.tenant.id });
  if (!magazine) return res.status(404).json({ error: '杂志不存在' });
  const pages = db.getPages(req.params.id, { tenantId: req.tenant.id });
  res.json({ ...magazine, pages });
});

app.post('/api/magazines', auth.requireAuth, (req, res) => {
  const { name, upload_date, description, cover_pc, cover_mobile } = req.body;
  if (!name || !upload_date) return res.status(400).json({ error: '名称和日期必填' });
  const mag = db.createMagazine(req.tenant.id, { name, upload_date, description, cover_pc, cover_mobile });
  res.json(mag);
});

app.put('/api/magazines/:id', auth.requireAuth, (req, res) => {
  const { name, upload_date, description, cover_pc, cover_mobile, enabled } = req.body;
  const updated = db.updateMagazine(req.params.id,
    { name, upload_date, description, cover_pc, cover_mobile, enabled },
    { tenantId: req.tenant.id }
  );
  if (!updated) return res.status(404).json({ error: '杂志不存在' });
  res.json(updated);
});

app.delete('/api/magazines/:id', auth.requireAuth, (req, res) => {
  const ok = db.deleteMagazine(req.params.id, { tenantId: req.tenant.id });
  res.json({ success: ok });
});

// ========== Pages ==========
app.post('/api/magazines/:id/pages', auth.requireAuth, upload.single('image'), async (req, res) => {
  const magazine = db.getMagazine(req.params.id, { tenantId: req.tenant.id });
  if (!magazine) return res.status(404).json({ error: '杂志不存在' });
  if (!req.file) return res.status(400).json({ error: '请上传图片' });
  try {
    const r = await persistUpload(req.file);
    res.json(db.addPage(req.tenant.id, req.params.id, r.path));
  } catch (err) { res.status(500).json({ error: 'OSS 上传失败: ' + err.message }); }
});

app.post('/api/magazines/:id/pages/batch', auth.requireAuth, upload.array('images', 50), async (req, res) => {
  const magazine = db.getMagazine(req.params.id, { tenantId: req.tenant.id });
  if (!magazine) return res.status(404).json({ error: '杂志不存在' });
  if (!req.files || !req.files.length) return res.status(400).json({ error: '请上传图片' });
  try {
    const results = await Promise.all(req.files.map(persistUpload));
    res.json(db.addPages(req.tenant.id, req.params.id, results.map(r => r.path)));
  } catch (err) { res.status(500).json({ error: 'OSS 批量上传失败: ' + err.message }); }
});

app.put('/api/magazines/:id/pages/reorder', auth.requireAuth, (req, res) => {
  const { orderedIds } = req.body;
  if (!Array.isArray(orderedIds)) return res.status(400).json({ error: 'orderedIds 必须是数组' });
  db.reorderPages(req.params.id, orderedIds, { tenantId: req.tenant.id });
  res.json({ success: true });
});

app.delete('/api/magazines/:id/pages/:pageId', auth.requireAuth, (req, res) => {
  const ok = db.deletePage(req.params.id, req.params.pageId, { tenantId: req.tenant.id });
  res.json({ success: ok });
});

// ========== Covers ==========
app.post('/api/covers/upload', auth.requireAuth, upload.single('image'), async (req, res) => {
  const { magazine_id, type } = req.body;
  if (!req.file) return res.status(400).json({ error: '请上传图片' });
  if (!['pc', 'mobile'].includes(type)) return res.status(400).json({ error: 'type 必须是 pc 或 mobile' });
  try {
    const r = await persistUpload(req.file);
    res.json(db.createCover(req.tenant.id, { magazine_id: magazine_id || null, type, image_path: r.path }));
  } catch (err) { res.status(500).json({ error: 'OSS 封面上传失败: ' + err.message }); }
});

app.get('/api/covers', auth.requireAuth, (req, res) => {
  const { magazine_id } = req.query;
  res.json(db.getAllCovers({ tenantId: req.tenant.id, magazine_id }));
});

app.delete('/api/covers/:id', auth.requireAuth, (req, res) => {
  const ok = db.deleteCover(req.params.id, { tenantId: req.tenant.id });
  res.json({ success: ok });
});

// 通用文件上传
app.post('/api/upload', auth.requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请上传文件' });
  try {
    const r = await persistUpload(req.file);
    res.json(r);
  } catch (err) { res.status(500).json({ error: 'OSS 上传失败: ' + err.message }); }
});

// ========== Publish ==========
// 把当前 data 序列化成 public-safe 的 JSON，推到 OSS 给阅读端拉
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
