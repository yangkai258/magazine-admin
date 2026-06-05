const fs = require('fs');
const path = require('path');

const dataPath = path.join(__dirname, 'data.json');

const defaultData = {
  tenants: [],
  magazines: [],
  pages: [],
  covers: []
};

let data = loadData();

// 热重载：data.json 被外部修改后自动重新加载（无需重启服务）
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
      const parsed = JSON.parse(raw);
      // 兼容旧数据（没有 tenants 字段）
      if (!parsed.tenants) parsed.tenants = [];
      return parsed;
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

// ========== Tenants ==========
function getAllTenants() {
  return (data.tenants || []).slice().sort((a, b) => a.id - b.id);
}

function getTenant(id) {
  return (data.tenants || []).find(t => t.id === Number(id));
}

function getTenantBySlug(slug) {
  return (data.tenants || []).find(t => t.slug === slug);
}

function createTenant({ slug, name, password }) {
  if (!slug || !name) throw new Error('slug and name are required');
  if (getTenantBySlug(slug)) throw new Error(`tenant slug '${slug}' already exists`);
  const tenant = {
    id: nextId(data.tenants || []),
    slug,
    name,
    password: password || '',  // 空密码 = 不可登录
    created_at: new Date().toISOString()
  };
  if (!data.tenants) data.tenants = [];
  data.tenants.push(tenant);
  saveData();
  return tenant;
}

function updateTenant(id, fields) {
  const idx = (data.tenants || []).findIndex(t => t.id === Number(id));
  if (idx === -1) return null;
  data.tenants[idx] = { ...data.tenants[idx], ...fields, id: data.tenants[idx].id };
  saveData();
  return data.tenants[idx];
}

function deleteTenant(id) {
  const tid = Number(id);
  if (!(data.tenants || []).find(t => t.id === tid)) return false;
  data.tenants = data.tenants.filter(t => t.id !== tid);
  // 级联删除该租户的所有数据
  data.magazines = data.magazines.filter(m => m.tenant_id !== tid);
  data.pages = data.pages.filter(p => p.tenant_id !== tid);
  data.covers = data.covers.filter(c => c.tenant_id !== tid);
  saveData();
  return true;
}

function verifyTenantPassword(slug, password) {
  const tenant = getTenantBySlug(slug);
  if (!tenant) return null;
  if (!tenant.password) return null;  // 没设密码不能登录
  if (tenant.password !== password) return null;
  return tenant;
}

// ========== Magazines ==========
// 租户过滤：调用方传 tenantId 才过滤；传 null/undefined 返回所有租户（仅平台管理员用）
function getAllMagazines({ tenantId, search, enabled } = {}) {
  let list = data.magazines;
  if (tenantId !== undefined && tenantId !== null) {
    list = list.filter(m => m.tenant_id === Number(tenantId));
  }
  if (search !== undefined) list = list.filter(m => m.name.includes(search));
  if (enabled !== undefined) list = list.filter(m => m.enabled === Number(enabled));
  return list.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

function getMagazine(id, { tenantId } = {}) {
  return data.magazines.find(m => {
    if (m.id !== Number(id)) return false;
    if (tenantId !== undefined && tenantId !== null && m.tenant_id !== Number(tenantId)) return false;
    return true;
  });
}

function createMagazine(tenantId, { name, upload_date, description, cover_pc, cover_mobile }) {
  const mag = {
    id: nextId(data.magazines),
    tenant_id: Number(tenantId),
    name, upload_date, description: description || '',
    cover_pc: cover_pc || '', cover_mobile: cover_mobile || '',
    enabled: 1,
    created_at: new Date().toISOString()
  };
  data.magazines.push(mag);
  saveData();
  return mag;
}

function updateMagazine(id, fields, { tenantId } = {}) {
  const idx = data.magazines.findIndex(m => {
    if (m.id !== Number(id)) return false;
    if (tenantId !== undefined && tenantId !== null && m.tenant_id !== Number(tenantId)) return false;
    return true;
  });
  if (idx === -1) return null;
  data.magazines[idx] = { ...data.magazines[idx], ...fields };
  saveData();
  return data.magazines[idx];
}

function deleteMagazine(id, { tenantId } = {}) {
  const before = data.magazines.length;
  data.magazines = data.magazines.filter(m => {
    if (m.id !== Number(id)) return false;
    if (tenantId !== undefined && tenantId !== null && m.tenant_id !== Number(tenantId)) return false;
    return true;
  });
  data.pages = data.pages.filter(p => {
    if (p.magazine_id !== Number(id)) return true;
    if (tenantId !== undefined && tenantId !== null && p.tenant_id !== Number(tenantId)) return true;
    return false;
  });
  saveData();
  return data.magazines.length < before;
}

// ========== Pages ==========
function getPages(magazineId, { tenantId } = {}) {
  return data.pages
    .filter(p => {
      if (p.magazine_id !== Number(magazineId)) return false;
      if (tenantId !== undefined && tenantId !== null && p.tenant_id !== Number(tenantId)) return false;
      return true;
    })
    .sort((a, b) => a.page_order - b.page_order);
}

function addPage(tenantId, magazineId, imagePath) {
  const maxOrder = data.pages
    .filter(p => p.magazine_id === Number(magazineId))
    .reduce((max, p) => Math.max(max, p.page_order), 0);
  const page = {
    id: nextId(data.pages),
    tenant_id: Number(tenantId),
    magazine_id: Number(magazineId),
    page_order: maxOrder + 1,
    image_path: imagePath,
    created_at: new Date().toISOString()
  };
  data.pages.push(page);
  saveData();
  return page;
}

function addPages(tenantId, magazineId, imagePaths) {
  const maxOrder = data.pages
    .filter(p => p.magazine_id === Number(magazineId))
    .reduce((max, p) => Math.max(max, p.page_order), 0);
  const newPages = imagePaths.map((image_path, i) => ({
    id: nextId(data.pages) + i,
    tenant_id: Number(tenantId),
    magazine_id: Number(magazineId),
    page_order: maxOrder + 1 + i,
    image_path,
    created_at: new Date().toISOString()
  }));
  data.pages.push(...newPages);
  saveData();
  return newPages;
}

function reorderPages(magazineId, orderedIds, { tenantId } = {}) {
  orderedIds.forEach((id, index) => {
    const page = data.pages.find(p => {
      if (p.id !== id || p.magazine_id !== Number(magazineId)) return false;
      if (tenantId !== undefined && tenantId !== null && p.tenant_id !== Number(tenantId)) return false;
      return true;
    });
    if (page) page.page_order = index + 1;
  });
  saveData();
  return true;
}

function deletePage(magazineId, pageId, { tenantId } = {}) {
  const before = data.pages.length;
  data.pages = data.pages.filter(p => {
    if (p.id === Number(pageId) && p.magazine_id === Number(magazineId)) {
      if (tenantId !== undefined && tenantId !== null && p.tenant_id !== Number(tenantId)) return true;
      return false;
    }
    return true;
  });
  saveData();
  return data.pages.length < before;
}

// ========== Covers ==========
function getAllCovers({ tenantId, magazine_id } = {}) {
  let list = data.covers;
  if (tenantId !== undefined && tenantId !== null) {
    list = list.filter(c => c.tenant_id === Number(tenantId));
  }
  if (magazine_id !== undefined) list = list.filter(c => c.magazine_id === Number(magazine_id));
  return list.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

function createCover(tenantId, { magazine_id, type, image_path }) {
  // 如果同租户+同杂志+同类型存在，先删掉（保证唯一）
  if (magazine_id && type) {
    data.covers = data.covers.filter(c => !(
      c.tenant_id === Number(tenantId) &&
      c.magazine_id === Number(magazine_id) &&
      c.type === type
    ));
  }
  const cover = {
    id: nextId(data.covers),
    tenant_id: Number(tenantId),
    magazine_id: magazine_id ? Number(magazine_id) : null,
    type,
    image_path,
    created_at: new Date().toISOString()
  };
  data.covers.push(cover);
  saveData();
  return cover;
}

function deleteCover(id, { tenantId } = {}) {
  const before = data.covers.length;
  data.covers = data.covers.filter(c => {
    if (c.id !== Number(id)) return true;
    if (tenantId !== undefined && tenantId !== null && c.tenant_id !== Number(tenantId)) return true;
    return false;
  });
  saveData();
  return data.covers.length < before;
}

// ========== Publish ==========
// 把内存中当前 data 序列化成 publish-safe 的快照（不含 _meta）
function snapshotForPublish() {
  return {
    tenants: (data.tenants || []).map(t => ({
      id: t.id, slug: t.slug, name: t.name
      // 不暴露 password
    })),
    magazines: data.magazines.map(m => ({
      id: m.id, tenant_id: m.tenant_id, name: m.name,
      upload_date: m.upload_date, description: m.description,
      cover_pc: m.cover_pc, cover_mobile: m.cover_mobile,
      enabled: m.enabled, created_at: m.created_at
    })),
    pages: data.pages.map(p => ({
      id: p.id, tenant_id: p.tenant_id, magazine_id: p.magazine_id,
      page_order: p.page_order, image_path: p.image_path, created_at: p.created_at
    })),
    covers: data.covers.map(c => ({
      id: c.id, tenant_id: c.tenant_id, magazine_id: c.magazine_id,
      type: c.type, image_path: c.image_path, created_at: c.created_at
    }))
  };
}

module.exports = {
  // tenants
  getAllTenants, getTenant, getTenantBySlug, createTenant, updateTenant, deleteTenant,
  verifyTenantPassword,
  // magazines
  getAllMagazines, getMagazine, createMagazine, updateMagazine, deleteMagazine,
  // pages
  getPages, addPage, addPages, reorderPages, deletePage,
  // covers
  getAllCovers, createCover, deleteCover,
  // publish
  snapshotForPublish
};
