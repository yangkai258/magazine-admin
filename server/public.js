// 公共阅读端（port 3001）：splash → directory → reader 三层；只暴露只读 API
const express = require('express');
const path = require('path');
const db = require('./db/init');

const app = express();
app.use(express.json());

// 静态资源：splash.html / directory.html / reader/ / images/ + /uploads
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));
app.get('/', (req, res) => res.redirect('/splash.html'));

// 公共读 API：只返回 enabled=1 的杂志
app.get('/api/public/magazines', (req, res) => {
  res.json(db.getAllMagazines({ enabled: 1 }));
});

app.get('/api/public/magazines/:id', (req, res) => {
  const magazine = db.getMagazine(req.params.id);
  if (!magazine || magazine.enabled !== 1) return res.status(404).json({ error: '杂志不存在' });
  const pages = db.getPages(req.params.id);
  res.json({ ...magazine, pages });
});

// 公共读端点：开屏/前台要用的封面。
// type=pc|mobile，返回该类型最新的全局封面（magazine_id=null），
// 找不到对应类型就 404 让前端降级到 logo。
app.get('/api/public/cover', (req, res) => {
  const { type } = req.query;
  if (!type || !['pc', 'mobile'].includes(type)) {
    return res.status(400).json({ error: 'type 必须是 pc 或 mobile' });
  }
  // getAllCovers 已按 created_at desc 排序；优先取全局（magazine_id=null）的该类型最新一张
  const all = db.getAllCovers({});
  const candidates = all.filter(c => c.type === type && c.magazine_id == null);
  if (candidates.length === 0) return res.status(404).json({ error: '该类型暂无封面' });
  res.json(candidates[0]);
});

module.exports = app;
