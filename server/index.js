const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const db = require('./db/init');

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

const dbDir = path.join(__dirname, '..', 'db');
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, '..', 'uploads')),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

// ========== Magazines ==========
app.get('/api/magazines', (req, res) => {
  const { search, enabled } = req.query;
  res.json(db.getAllMagazines({ search, enabled }));
});

app.get('/api/magazines/:id', (req, res) => {
  const magazine = db.getMagazine(req.params.id);
  if (!magazine) return res.status(404).json({ error: '杂志不存在' });
  const pages = db.getPages(req.params.id);
  res.json({ ...magazine, pages });
});

app.post('/api/magazines', (req, res) => {
  const { name, upload_date, description, cover_pc, cover_mobile } = req.body;
  if (!name || !upload_date) return res.status(400).json({ error: '名称和日期必填' });
  const mag = db.createMagazine({ name, upload_date, description, cover_pc, cover_mobile });
  res.json(mag);
});

app.put('/api/magazines/:id', (req, res) => {
  const { name, upload_date, description, cover_pc, cover_mobile, enabled } = req.body;
  const updated = db.updateMagazine(req.params.id, { name, upload_date, description, cover_pc, cover_mobile, enabled });
  if (!updated) return res.status(404).json({ error: '杂志不存在' });
  res.json(updated);
});

app.delete('/api/magazines/:id', (req, res) => {
  db.deleteMagazine(req.params.id);
  res.json({ success: true });
});

// ========== Pages ==========
app.post('/api/magazines/:id/pages', upload.single('image'), (req, res) => {
  const magazine = db.getMagazine(req.params.id);
  if (!magazine) return res.status(404).json({ error: '杂志不存在' });
  if (!req.file) return res.status(400).json({ error: '请上传图片' });
  const imagePath = '/uploads/' + req.file.filename;
  res.json(db.addPage(req.params.id, imagePath));
});

app.post('/api/magazines/:id/pages/batch', upload.array('images', 50), (req, res) => {
  const magazine = db.getMagazine(req.params.id);
  if (!magazine) return res.status(404).json({ error: '杂志不存在' });
  if (!req.files || !req.files.length) return res.status(400).json({ error: '请上传图片' });
  const imagePaths = req.files.map(f => '/uploads/' + f.filename);
  res.json(db.addPages(req.params.id, imagePaths));
});

app.put('/api/magazines/:id/pages/reorder', (req, res) => {
  const { orderedIds } = req.body;
  if (!Array.isArray(orderedIds)) return res.status(400).json({ error: 'orderedIds 必须是数组' });
  db.reorderPages(req.params.id, orderedIds);
  res.json({ success: true });
});

app.delete('/api/magazines/:id/pages/:pageId', (req, res) => {
  db.deletePage(req.params.id, req.params.pageId);
  res.json({ success: true });
});

// ========== Covers ==========
app.post('/api/covers/upload', upload.single('image'), (req, res) => {
  const { magazine_id, type } = req.body;
  if (!req.file) return res.status(400).json({ error: '请上传图片' });
  if (!['pc', 'mobile'].includes(type)) return res.status(400).json({ error: 'type 必须是 pc 或 mobile' });
  const imagePath = '/uploads/' + req.file.filename;
  res.json(db.createCover({ magazine_id: magazine_id || null, type, image_path: imagePath }));
});

app.get('/api/covers', (req, res) => {
  const { magazine_id } = req.query;
  res.json(db.getAllCovers({ magazine_id }));
});

app.delete('/api/covers/:id', (req, res) => {
  db.deleteCover(req.params.id);
  res.json({ success: true });
});

// 通用文件上传
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请上传文件' });
  res.json({ path: '/uploads/' + req.file.filename, filename: req.file.filename });
});

app.listen(PORT, () => {
  console.log(`杂志管理平台已启动: http://localhost:${PORT}`);
});