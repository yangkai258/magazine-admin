const fs = require('fs');
const path = require('path');

const dataPath = path.join(__dirname, '..', 'db', 'data.json');

const defaultData = {
  magazines: [],
  pages: [],
  covers: []
};

let data = loadData();

// 热重载：data.json 被外部修改后自动重新加载（无需重启服务）
// 这样后台改完数据前台立刻能看到，不用每次都重启 node
try {
  fs.watchFile(dataPath, { interval: 1000 }, (curr, prev) => {
    if (curr.mtimeMs === prev.mtimeMs) return;
    console.log('[db] data.json changed, reloading...');
    data = loadData();
  });
} catch (e) {
  console.error('[db] watchFile failed:', e.message);
}

function loadData() {
  try {
    if (fs.existsSync(dataPath)) {
      const raw = fs.readFileSync(dataPath, 'utf8');
      return JSON.parse(raw);
    }
  } catch (e) { console.error('loadData error:', e.message); }
  return JSON.parse(JSON.stringify(defaultData));
}

function saveData() {
  try {
    fs.writeFileSync(dataPath, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) { console.error('saveData error:', e.message); }
}

function nextId(arr) {
  if (arr.length === 0) return 1;
  return Math.max(...arr.map(i => i.id)) + 1;
}

// ========== Magazines ==========
function getAllMagazines({ search, enabled } = {}) {
  let list = data.magazines;
  if (search !== undefined) list = list.filter(m => m.name.includes(search));
  if (enabled !== undefined) list = list.filter(m => m.enabled === Number(enabled));
  return list.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

function getMagazine(id) {
  return data.magazines.find(m => m.id === Number(id));
}

function createMagazine({ name, upload_date, description, cover_pc, cover_mobile }) {
  const mag = {
    id: nextId(data.magazines),
    name, upload_date, description: description || '',
    cover_pc: cover_pc || '', cover_mobile: cover_mobile || '',
    enabled: 1,
    created_at: new Date().toISOString()
  };
  data.magazines.push(mag);
  saveData();
  return mag;
}

function updateMagazine(id, fields) {
  const idx = data.magazines.findIndex(m => m.id === Number(id));
  if (idx === -1) return null;
  data.magazines[idx] = { ...data.magazines[idx], ...fields };
  saveData();
  return data.magazines[idx];
}

function deleteMagazine(id) {
  const before = data.magazines.length;
  data.magazines = data.magazines.filter(m => m.id !== Number(id));
  data.pages = data.pages.filter(p => p.magazine_id !== Number(id));
  saveData();
  return data.magazines.length < before;
}

// ========== Pages ==========
function getPages(magazineId) {
  return data.pages.filter(p => p.magazine_id === Number(magazineId)).sort((a, b) => a.page_order - b.page_order);
}

function addPage(magazineId, imagePath) {
  const maxOrder = data.pages.filter(p => p.magazine_id === Number(magazineId)).reduce((max, p) => Math.max(max, p.page_order), 0);
  const page = {
    id: nextId(data.pages),
    magazine_id: Number(magazineId),
    page_order: maxOrder + 1,
    image_path: imagePath,
    created_at: new Date().toISOString()
  };
  data.pages.push(page);
  saveData();
  return page;
}

function addPages(magazineId, imagePaths) {
  const maxOrder = data.pages.filter(p => p.magazine_id === Number(magazineId)).reduce((max, p) => Math.max(max, p.page_order), 0);
  const newPages = imagePaths.map((image_path, i) => ({
    id: nextId(data.pages) + i,
    magazine_id: Number(magazineId),
    page_order: maxOrder + 1 + i,
    image_path,
    created_at: new Date().toISOString()
  }));
  data.pages.push(...newPages);
  saveData();
  return newPages;
}

function reorderPages(magazineId, orderedIds) {
  orderedIds.forEach((id, index) => {
    const page = data.pages.find(p => p.id === id && p.magazine_id === Number(magazineId));
    if (page) page.page_order = index + 1;
  });
  saveData();
  return true;
}

function deletePage(magazineId, pageId) {
  const before = data.pages.length;
  data.pages = data.pages.filter(p => !(p.id === Number(pageId) && p.magazine_id === Number(magazineId)));
  saveData();
  return data.pages.length < before;
}

// ========== Covers ==========
function getAllCovers({ magazine_id } = {}) {
  let list = data.covers;
  if (magazine_id !== undefined) list = list.filter(c => c.magazine_id === Number(magazine_id));
  return list.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

function createCover({ magazine_id, type, image_path }) {
  // 如果同杂志+同类型存在，先删掉
  if (magazine_id && type) {
    data.covers = data.covers.filter(c => !(c.magazine_id === Number(magazine_id) && c.type === type));
  }
  const cover = {
    id: nextId(data.covers),
    magazine_id: magazine_id ? Number(magazine_id) : null,
    type,
    image_path,
    created_at: new Date().toISOString()
  };
  data.covers.push(cover);
  saveData();
  return cover;
}

function deleteCover(id) {
  const before = data.covers.length;
  data.covers = data.covers.filter(c => c.id !== Number(id));
  saveData();
  return data.covers.length < before;
}

module.exports = {
  getAllMagazines, getMagazine, createMagazine, updateMagazine, deleteMagazine,
  getPages, addPage, addPages, reorderPages, deletePage,
  getAllCovers, createCover, deleteCover
};