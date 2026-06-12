const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dataPath = path.join(__dirname, 'data.json');

const defaultData = {
  tenants: [],
  users: [],
  plans: [],
  subscriptions: [],
  invoices: [],
  payment_methods: [],
  magazines: [],
  pages: [],
  covers: [],
  audit_log: [],
  reader_analytics: [],
  signup_tokens: [],
  password_reset_tokens: [],
  email_log: [],
  user_invitations: [],
  _meta: { schema_version: 6 }
};

let data = loadData();

// 热重载：data.json 被外部修改后自动重新加载
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
      // 兼容旧数据（schema v1/v2/v3 缺字段）
      const requiredArrays = [
        'tenants', 'users', 'plans', 'subscriptions', 'invoices', 'payment_methods',
        'magazines', 'pages', 'covers', 'audit_log', 'reader_analytics',
        'signup_tokens', 'password_reset_tokens', 'email_log', 'user_invitations'
      ];
      requiredArrays.forEach(k => { if (!parsed[k]) parsed[k] = []; });
      // 兼容老 tenants 缺字段
      let needsSave = false;
      const nowIso = new Date().toISOString();
      parsed.tenants.forEach(t => {
        if (t.is_platform_admin === undefined) t.is_platform_admin = false;
        if (t.suspended === undefined) t.suspended = false;
        if (t.logo_url === undefined) t.logo_url = '';
        if (t.primary_color === undefined) t.primary_color = '#4f46e5';
        if (t.plan_id === undefined) t.plan_id = null;
        if (t.subscription_status === undefined) t.subscription_status = 'active';
        if (t.trial_ends_at === undefined) t.trial_ends_at = null;
        // v5：reader_secret（老 tenant 缺字段就生成并立即持久化，保证 server 重启后 link 仍可用）
        if (!t.reader_secret) {
          t.reader_secret = generateReaderSecret();
          t.reader_secret_created_at = t.reader_secret_created_at || nowIso;
          t.reader_secret_updated_at = t.reader_secret_updated_at || nowIso;
          needsSave = true;
        }
      });
      // 缺 _meta
      if (!parsed._meta) parsed._meta = { schema_version: 3, migrated_at: nowIso };
      // v5：升 schema_version（v4 → v5）
      if (!parsed._meta.schema_version || parsed._meta.schema_version < 5) {
        parsed._meta.schema_version = 5;
        parsed._meta.migrated_at = nowIso;
        needsSave = true;
      }
      // 兼容老 pages 缺字段（v6：AI 一句话生成画册骨架新增 title/body/is_skeleton）
      parsed.pages.forEach(p => {
        if (p.title === undefined) p.title = '';
        if (p.body === undefined) p.body = '';
        if (p.is_skeleton === undefined) p.is_skeleton = false;
      });
      // v6：升 schema_version（v5 → v6）
      if (!parsed._meta.schema_version || parsed._meta.schema_version < 6) {
        parsed._meta.schema_version = 6;
        parsed._meta.migrated_at = nowIso;
        needsSave = true;
      }
      // 立即持久化 backfill 的 reader_secret / schema_version（避免重启后重新生成，破坏 link 稳定性）
      if (needsSave) {
        try { fs.writeFileSync(dataPath, JSON.stringify(parsed, null, 2), 'utf8'); } catch (e) { console.error('loadData persist error:', e.message); }
      }
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
  if (!arr) arr = [];
  if (arr.length === 0) return 1;
  return Math.max(...arr.map(i => i.id || 0)) + 1;
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

// v5：reader 端鉴权 secret。32 字符 base64url，24 字节熵
function generateReaderSecret() {
  return crypto.randomBytes(24).toString('base64url');
}

function hashPassword(password) {
  // 简化：SHA-256 + salt（生产环境应该用 bcrypt/argon2）
  const salt = 'mag-static-salt-v4';
  return crypto.createHash('sha256').update(salt + password).digest('hex');
}

// ========== Tenants ==========
function getAllTenants() { return (data.tenants || []).slice().sort((a, b) => a.id - b.id); }
function getTenant(id) { return (data.tenants || []).find(t => t.id === Number(id)); }
function getTenantBySlug(slug) { return (data.tenants || []).find(t => t.slug === slug); }

function createTenant({ slug, name, logo_url, primary_color, plan_id, reader_secret }) {
  if (!slug || !name) throw new Error('slug and name are required');
  if (getTenantBySlug(slug)) throw new Error(`tenant slug '${slug}' already exists`);
  const nowIso = new Date().toISOString();
  const tenant = {
    id: nextId(data.tenants),
    slug, name,
    logo_url: logo_url || '',
    primary_color: primary_color || '#4f46e5',
    is_platform_admin: false,
    suspended: false,
    plan_id: plan_id || null,
    subscription_status: 'active',
    trial_ends_at: null,
    password: '',  // 老字段保留：tenant-level fallback 密码（不推荐用，新流程走 user）
    // v5：reader 端 URL 鉴权 secret；不传则自动生成
    reader_secret: reader_secret || generateReaderSecret(),
    reader_secret_created_at: nowIso,
    reader_secret_updated_at: nowIso,
    created_at: nowIso
  };
  data.tenants.push(tenant);
  saveData();
  return tenant;
}

function updateTenant(id, fields) {
  const idx = (data.tenants || []).findIndex(t => t.id === Number(id));
  if (idx === -1) return null;
  data.tenants[idx] = {
    ...data.tenants[idx],
    ...fields,
    id: data.tenants[idx].id,
    created_at: data.tenants[idx].created_at
  };
  saveData();
  return data.tenants[idx];
}

function setTenantSuspended(id, suspended) { return updateTenant(id, { suspended: !!suspended }); }

// v5：reader 端 URL secret（admin 内部用，不通过 public API 暴露）
function setTenantReaderSecret(id, secret) {
  const nowIso = new Date().toISOString();
  return updateTenant(id, {
    reader_secret: secret,
    reader_secret_updated_at: nowIso
  });
}

function getReaderSecret(tenantId) {
  const t = getTenant(tenantId);
  return t ? (t.reader_secret || null) : null;
}

function deleteTenant(id) {
  const tid = Number(id);
  if (!(data.tenants || []).find(t => t.id === tid)) return false;
  data.tenants = data.tenants.filter(t => t.id !== tid);
  data.users = data.users.filter(u => u.tenant_id !== tid);
  data.magazines = data.magazines.filter(m => m.tenant_id !== tid);
  data.pages = data.pages.filter(p => p.tenant_id !== tid);
  data.covers = data.covers.filter(c => c.tenant_id !== tid);
  data.subscriptions = data.subscriptions.filter(s => s.tenant_id !== tid);
  data.invoices = data.invoices.filter(i => i.tenant_id !== tid);
  data.payment_methods = data.payment_methods.filter(p => p.tenant_id !== tid);
  data.user_invitations = data.user_invitations.filter(i => i.tenant_id !== tid);
  saveData();
  return true;
}

// ========== Users（v4 新增） ==========
function getAllUsers({ tenantId } = {}) {
  let list = data.users || [];
  if (tenantId !== undefined && tenantId !== null) {
    list = list.filter(u => u.tenant_id === Number(tenantId));
  }
  return list.sort((a, b) => a.id - b.id);
}
function getUser(id) { return (data.users || []).find(u => u.id === Number(id)); }
function getUserByEmail(tenantId, email) {
  return (data.users || []).find(u => u.tenant_id === Number(tenantId) && u.email.toLowerCase() === email.toLowerCase());
}

function createUser({ tenant_id, email, password, role, name }) {
  if (!tenant_id) throw new Error('tenant_id required');
  if (!email || !password) throw new Error('email and password required');
  if (!['owner', 'editor', 'viewer'].includes(role)) throw new Error('role must be owner/editor/viewer');
  if (getUserByEmail(tenant_id, email)) throw new Error(`email ${email} already exists in this tenant`);
  const user = {
    id: nextId(data.users),
    tenant_id: Number(tenant_id),
    email: email.toLowerCase(),
    password_hash: hashPassword(password),
    role,
    name: name || email.split('@')[0],
    status: 'active',
    created_at: new Date().toISOString(),
    last_login_at: null
  };
  data.users.push(user);
  saveData();
  return user;
}

function updateUser(id, fields) {
  const idx = (data.users || []).findIndex(u => u.id === Number(id));
  if (idx === -1) return null;
  if (fields.password) fields.password_hash = hashPassword(fields.password);
  delete fields.password;
  data.users[idx] = { ...data.users[idx], ...fields, id: data.users[idx].id, created_at: data.users[idx].created_at };
  saveData();
  return data.users[idx];
}

function setUserPassword(id, password) {
  return updateUser(id, { password_hash: hashPassword(password) });
}

function deleteUser(id) {
  const idx = (data.users || []).findIndex(u => u.id === Number(id));
  if (idx === -1) return false;
  data.users.splice(idx, 1);
  saveData();
  return true;
}

function verifyUserPassword(tenantId, email, password) {
  const user = getUserByEmail(tenantId, email);
  if (!user) return null;
  if (user.status !== 'active') return null;
  const tenant = getTenant(tenantId);
  if (tenant && tenant.suspended) return null;
  if (user.password_hash !== hashPassword(password)) return null;
  return user;
}

// ========== Plans / Subscriptions / Invoices（计费基础） ==========
function getAllPlans() { return (data.plans || []).sort((a, b) => (a.price_monthly_cny || 0) - (b.price_monthly_cny || 0)); }
function getPlan(id) { return (data.plans || []).find(p => p.id === Number(id)); }
function getPlanBySlug(slug) { return (data.plans || []).find(p => p.slug === slug); }
function createPlan({ slug, name, price_monthly_cny, features }) {
  const plan = { id: nextId(data.plans), slug, name, price_monthly_cny: price_monthly_cny || 0, features: features || {} };
  data.plans.push(plan);
  saveData();
  return plan;
}

function getActiveSubscription(tenantId) {
  const now = Date.now();
  return (data.subscriptions || []).find(s =>
    s.tenant_id === Number(tenantId) &&
    s.status === 'active' &&
    new Date(s.ends_at).getTime() > now
  );
}

function createSubscription({ tenant_id, plan_id, started_at, ends_at, status, external_id }) {
  const sub = {
    id: nextId(data.subscriptions),
    tenant_id: Number(tenant_id),
    plan_id: Number(plan_id),
    started_at: started_at || new Date().toISOString(),
    ends_at: ends_at || new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
    status: status || 'active',
    external_id: external_id || null,
    created_at: new Date().toISOString()
  };
  data.subscriptions.push(sub);
  saveData();
  return sub;
}

function getInvoices(tenantId) {
  return (data.invoices || [])
    .filter(i => i.tenant_id === Number(tenantId))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}
function createInvoice({ tenant_id, plan_id, amount_cny, period_start, period_end, status, external_id, payment_method }) {
  const inv = {
    id: nextId(data.invoices),
    tenant_id: Number(tenant_id),
    plan_id: Number(plan_id),
    amount_cny: amount_cny || 0,
    currency: 'CNY',
    period_start: period_start || new Date().toISOString(),
    period_end: period_end || new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
    status: status || 'pending',  // pending / paid / failed / refunded
    external_id: external_id || null,
    payment_method: payment_method || null,
    created_at: new Date().toISOString(),
    paid_at: null
  };
  data.invoices.push(inv);
  saveData();
  return inv;
}
function updateInvoice(id, fields) {
  const idx = (data.invoices || []).findIndex(i => i.id === Number(id));
  if (idx === -1) return null;
  data.invoices[idx] = { ...data.invoices[idx], ...fields };
  saveData();
  return data.invoices[idx];
}

function getPaymentMethods(tenantId) {
  return (data.payment_methods || []).filter(p => p.tenant_id === Number(tenantId));
}
function createPaymentMethod({ tenant_id, type, external_account, label }) {
  const m = {
    id: nextId(data.payment_methods),
    tenant_id: Number(tenant_id),
    type,  // 'alipay' | 'wechat'
    external_account: external_account || '',
    label: label || '',
    created_at: new Date().toISOString()
  };
  data.payment_methods.push(m);
  saveData();
  return m;
}
function deletePaymentMethod(id) {
  const before = (data.payment_methods || []).length;
  data.payment_methods = data.payment_methods.filter(p => p.id !== Number(id));
  saveData();
  return data.payment_methods.length < before;
}

// ========== Signup / Password Reset Tokens ==========
function createSignupToken({ email, tenant_slug, tenant_name, token, expires_in_hours }) {
  const t = {
    id: nextId(data.signup_tokens),
    email: email.toLowerCase(),
    tenant_slug,
    tenant_name,
    token: token || randomToken(),
    expires_at: new Date(Date.now() + (expires_in_hours || 24) * 3600 * 1000).toISOString(),
    used_at: null,
    created_at: new Date().toISOString()
  };
  data.signup_tokens.push(t);
  saveData();
  return t;
}
function getSignupToken(token) {
  return (data.signup_tokens || []).find(t => t.token === token);
}
function markSignupTokenUsed(token) {
  const t = getSignupToken(token);
  if (!t) return null;
  t.used_at = new Date().toISOString();
  saveData();
  return t;
}

function createPasswordResetToken(userId) {
  // 同一个 user 只保留一个未使用的 token
  data.password_reset_tokens = (data.password_reset_tokens || []).filter(t => t.user_id !== userId || t.used_at);
  const t = {
    id: nextId(data.password_reset_tokens),
    user_id: userId,
    token: randomToken(),
    expires_at: new Date(Date.now() + 1 * 3600 * 1000).toISOString(),  // 1h
    used_at: null,
    created_at: new Date().toISOString()
  };
  data.password_reset_tokens.push(t);
  saveData();
  return t;
}
function getPasswordResetToken(token) {
  return (data.password_reset_tokens || []).find(t => t.token === token);
}
function markPasswordResetTokenUsed(token) {
  const t = getPasswordResetToken(token);
  if (!t) return null;
  t.used_at = new Date().toISOString();
  saveData();
  return t;
}

function createUserInvitation({ tenant_id, email, role, invited_by, token, expires_in_hours }) {
  const inv = {
    id: nextId(data.user_invitations),
    tenant_id: Number(tenant_id),
    email: email.toLowerCase(),
    role,
    invited_by: Number(invited_by),
    token: token || randomToken(),
    expires_at: new Date(Date.now() + (expires_in_hours || 72) * 3600 * 1000).toISOString(),
    accepted_at: null,
    created_at: new Date().toISOString()
  };
  data.user_invitations.push(inv);
  saveData();
  return inv;
}
function getUserInvitations(tenantId) {
  return (data.user_invitations || [])
    .filter(i => i.tenant_id === Number(tenantId))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}
function getUserInvitationByToken(token) {
  return (data.user_invitations || []).find(i => i.token === token);
}
function markUserInvitationAccepted(token) {
  const inv = getUserInvitationByToken(token);
  if (!inv) return null;
  inv.accepted_at = new Date().toISOString();
  saveData();
  return inv;
}

// ========== Email Log ==========
function logEmail({ to_email, subject, body, status, error }) {
  const entry = {
    id: nextId(data.email_log),
    to_email,
    subject: subject || '',
    body: body || '',
    status: status || 'sent',  // sent / failed / pending
    error: error || null,
    sent_at: new Date().toISOString()
  };
  data.email_log.push(entry);
  // 限 5000 条
  if (data.email_log.length > 5000) data.email_log = data.email_log.slice(-5000);
  saveData();
  return entry;
}
function getEmailLog({ to_email, status, limit = 200, offset = 0 } = {}) {
  let list = (data.email_log || []).slice();
  if (to_email) list = list.filter(e => e.to_email === to_email);
  if (status) list = list.filter(e => e.status === status);
  list.sort((a, b) => b.sent_at.localeCompare(a.sent_at));
  return { total: list.length, items: list.slice(offset, offset + limit) };
}

// ========== Audit Log（v3 已加，保留） ==========
function addAuditLog(entry) {
  if (!data.audit_log) data.audit_log = [];
  const log = {
    id: nextId(data.audit_log),
    timestamp: new Date().toISOString(),
    actor_user_id: entry.actor_user_id || null,
    actor_user_email: entry.actor_user_email || null,
    actor_tenant_id: entry.actor_tenant_id || null,
    actor_tenant_slug: entry.actor_tenant_slug || null,
    actor_is_platform_admin: !!entry.actor_is_platform_admin,
    actor_role: entry.actor_role || null,
    tenant_id: entry.tenant_id || null,
    action: entry.action,
    target_type: entry.target_type || null,
    target_id: entry.target_id || null,
    details: entry.details || null,
    ip: entry.ip || null,
    user_agent: entry.user_agent || null
  };
  data.audit_log.push(log);
  if (data.audit_log.length > 10000) data.audit_log = data.audit_log.slice(-10000);
  saveData();
  return log;
}
function getAuditLogs({ tenantId, actorUserId, action, limit = 200, offset = 0 } = {}) {
  let list = (data.audit_log || []).slice();
  if (tenantId !== undefined && tenantId !== null) list = list.filter(l => l.tenant_id === Number(tenantId));
  if (actorUserId !== undefined && actorUserId !== null) list = list.filter(l => l.actor_user_id === Number(actorUserId));
  if (action) list = list.filter(l => l.action === action);
  list.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return { total: list.length, items: list.slice(offset, offset + limit) };
}

// ========== Reader Analytics（v4 新增） ==========
function addReaderEvent(event) {
  if (!data.reader_analytics) data.reader_analytics = [];
  const e = {
    id: nextId(data.reader_analytics),
    tenant_id: Number(event.tenant_id),
    magazine_id: event.magazine_id ? Number(event.magazine_id) : null,
    page_id: event.page_id ? Number(event.page_id) : null,
    viewer_id: event.viewer_id || 'anon',  // 匿名访客 hash
    event_type: event.event_type,  // view / dwell / complete
    page_number: event.page_number || null,
    duration_ms: event.duration_ms || null,
    referrer: event.referrer || null,
    user_agent: event.user_agent || null,
    ts: new Date().toISOString()
  };
  data.reader_analytics.push(e);
  // 限 50000 条
  if (data.reader_analytics.length > 50000) data.reader_analytics = data.reader_analytics.slice(-50000);
  saveData();
  return e;
}
function getReaderStats({ tenantId, magazineId, since, until } = {}) {
  const events = (data.reader_analytics || []).filter(e => {
    if (tenantId !== undefined && e.tenant_id !== Number(tenantId)) return false;
    if (magazineId !== undefined && e.magazine_id !== Number(magazineId)) return false;
    if (since && new Date(e.ts) < new Date(since)) return false;
    if (until && new Date(e.ts) > new Date(until)) return false;
    return true;
  });
  const views = events.filter(e => e.event_type === 'view');
  const completes = events.filter(e => e.event_type === 'complete');
  const dwells = events.filter(e => e.event_type === 'dwell' && e.duration_ms);
  const uniqueViewers = new Set(views.map(e => e.viewer_id)).size;
  return {
    total_views: views.length,
    unique_viewers: uniqueViewers,
    completes: completes.length,
    avg_dwell_ms: dwells.length > 0 ? Math.round(dwells.reduce((s, e) => s + (e.duration_ms || 0), 0) / dwells.length) : 0,
    events
  };
}
function getReaderStatsByMagazine(tenantId, since) {
  const stats = getReaderStats({ tenantId, since });
  const byMag = {};
  stats.events.forEach(e => {
    if (!e.magazine_id) return;
    if (!byMag[e.magazine_id]) byMag[e.magazine_id] = { magazine_id: e.magazine_id, views: 0, unique_viewers: new Set(), completes: 0, dwell_total_ms: 0, dwell_count: 0 };
    byMag[e.magazine_id].views++;
    byMag[e.magazine_id].unique_viewers.add(e.viewer_id);
    if (e.event_type === 'complete') byMag[e.magazine_id].completes++;
    if (e.event_type === 'dwell' && e.duration_ms) { byMag[e.magazine_id].dwell_total_ms += e.duration_ms; byMag[e.magazine_id].dwell_count++; }
  });
  return Object.values(byMag).map(s => ({
    magazine_id: s.magazine_id,
    views: s.views,
    unique_viewers: s.unique_viewers.size,
    completes: s.completes,
    avg_dwell_ms: s.dwell_count > 0 ? Math.round(s.dwell_total_ms / s.dwell_count) : 0
  })).sort((a, b) => b.views - a.views);
}

// ========== Magazines / Pages / Covers (v3 已加，保留签名) ==========
function getAllMagazines({ tenantId, search, enabled } = {}) {
  let list = data.magazines;
  if (tenantId !== undefined && tenantId !== null) list = list.filter(m => m.tenant_id === Number(tenantId));
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
function createMagazine(tenantId, { name, upload_date, description, cover_pc, cover_mobile, enabled }) {
  const mag = {
    id: nextId(data.magazines),
    tenant_id: Number(tenantId),
    name, upload_date, description: description || '',
    cover_pc: cover_pc || '', cover_mobile: cover_mobile || '',
    // enabled 不传则默认 1（已上线杂志）；v6.0 AI skeleton 走 0（草稿，待用户上传图后发布）
    enabled: enabled === undefined ? 1 : (enabled ? 1 : 0),
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
function getPages(magazineId, { tenantId } = {}) {
  return data.pages
    .filter(p => {
      if (p.magazine_id !== Number(magazineId)) return false;
      if (tenantId !== undefined && tenantId !== null && p.tenant_id !== Number(tenantId)) return false;
      return true;
    })
    .sort((a, b) => a.page_order - b.page_order);
}
function addPage(tenantId, magazineId, imagePath, extras) {
  const maxOrder = data.pages.filter(p => p.magazine_id === Number(magazineId)).reduce((max, p) => Math.max(max, p.page_order), 0);
  const page = {
    id: nextId(data.pages),
    tenant_id: Number(tenantId),
    magazine_id: Number(magazineId),
    page_order: maxOrder + 1,
    image_path: imagePath,
    title: (extras && typeof extras.title === 'string') ? extras.title : '',
    body: (extras && typeof extras.body === 'string') ? extras.body : '',
    is_skeleton: !!(extras && extras.is_skeleton),
    created_at: new Date().toISOString()
  };
  data.pages.push(page);
  saveData();
  return page;
}
function addPages(tenantId, magazineId, pageInputs) {
  // pageInputs 支持两种形态：
  //   旧用法：string[]（仅 image_path）
  //   新用法：Array<{ image_path, title?, body?, is_skeleton? }>
  const maxOrder = data.pages.filter(p => p.magazine_id === Number(magazineId)).reduce((max, p) => Math.max(max, p.page_order), 0);
  const newPages = pageInputs.map((input, i) => {
    const image_path = typeof input === 'string' ? input : input.image_path;
    const title = (typeof input === 'object' && typeof input.title === 'string') ? input.title : '';
    const body = (typeof input === 'object' && typeof input.body === 'string') ? input.body : '';
    const is_skeleton = !!(typeof input === 'object' && input.is_skeleton);
    return {
      id: nextId(data.pages) + i,
      tenant_id: Number(tenantId),
      magazine_id: Number(magazineId),
      page_order: maxOrder + 1 + i,
      image_path,
      title,
      body,
      is_skeleton,
      created_at: new Date().toISOString()
    };
  });
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
function getAllCovers({ tenantId, magazine_id } = {}) {
  let list = data.covers;
  if (tenantId !== undefined && tenantId !== null) list = list.filter(c => c.tenant_id === Number(tenantId));
  if (magazine_id !== undefined) list = list.filter(c => c.magazine_id === Number(magazine_id));
  return list.sort((a, b) => b.created_at.localeCompare(a.created_at));
}
function createCover(tenantId, { magazine_id, type, image_path }) {
  if (magazine_id && type) {
    data.covers = data.covers.filter(c => !(c.tenant_id === Number(tenantId) && c.magazine_id === Number(magazine_id) && c.type === type));
  }
  const cover = { id: nextId(data.covers), tenant_id: Number(tenantId), magazine_id: magazine_id ? Number(magazine_id) : null, type, image_path, created_at: new Date().toISOString() };
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

function getTenantUsage(tenantId) {
  const tid = Number(tenantId);
  return {
    tenant_id: tid,
    magazine_count: data.magazines.filter(m => m.tenant_id === tid).length,
    enabled_magazine_count: data.magazines.filter(m => m.tenant_id === tid && m.enabled === 1).length,
    page_count: data.pages.filter(p => p.tenant_id === tid).length,
    cover_count: data.covers.filter(c => c.tenant_id === tid).length,
    user_count: (data.users || []).filter(u => u.tenant_id === tid).length
  };
}

function snapshotForPublish({ tenantId } = {}) {
  // 公共发布快照：tenant 字段**绝不**包含 reader_secret（防泄漏）
  // helper：过滤掉 suspended 租户 + 按 tenantId 收敛（防单租户外泄）
  const matchesTenant = (id) => tenantId === undefined || tenantId === null || Number(id) === Number(tenantId);
  const stripTenant = (t) => ({
    id: t.id, slug: t.slug, name: t.name,
    logo_url: t.logo_url || '',
    primary_color: t.primary_color || '#4f46e5'
  });
  const isLiveTenant = (id) => {
    const t = (data.tenants || []).find(x => x.id === id);
    return t && !t.suspended && matchesTenant(id);
  };
  return {
    tenants: (data.tenants || [])
      .filter(t => !t.suspended && matchesTenant(t.id))
      .map(stripTenant),
    magazines: data.magazines
      .filter(m => isLiveTenant(m.tenant_id))
      .map(m => ({
        id: m.id, tenant_id: m.tenant_id, name: m.name,
        upload_date: m.upload_date, description: m.description,
        cover_pc: m.cover_pc, cover_mobile: m.cover_mobile,
        enabled: m.enabled, created_at: m.created_at
      })),
    pages: data.pages
      .filter(p => isLiveTenant(p.tenant_id))
      .map(p => ({ id: p.id, tenant_id: p.tenant_id, magazine_id: p.magazine_id, page_order: p.page_order, image_path: p.image_path, title: p.title || '', body: p.body || '', is_skeleton: !!p.is_skeleton, created_at: p.created_at })),
    covers: data.covers
      .filter(c => isLiveTenant(c.tenant_id))
      .map(c => ({ id: c.id, tenant_id: c.tenant_id, magazine_id: c.magazine_id, type: c.type, image_path: c.image_path, created_at: c.created_at }))
  };
}

module.exports = {
  // tenants
  getAllTenants, getTenant, getTenantBySlug, createTenant, updateTenant, setTenantSuspended, deleteTenant,
  // v5: reader secret
  setTenantReaderSecret, getReaderSecret, generateReaderSecret,
  // users (v4)
  getAllUsers, getUser, getUserByEmail, createUser, updateUser, setUserPassword, deleteUser, verifyUserPassword,
  // plans / subs / invoices (v4)
  getAllPlans, getPlan, getPlanBySlug, createPlan,
  getActiveSubscription, createSubscription,
  getInvoices, createInvoice, updateInvoice,
  getPaymentMethods, createPaymentMethod, deletePaymentMethod,
  // tokens (v4)
  createSignupToken, getSignupToken, markSignupTokenUsed,
  createPasswordResetToken, getPasswordResetToken, markPasswordResetTokenUsed,
  createUserInvitation, getUserInvitations, getUserInvitationByToken, markUserInvitationAccepted,
  // email log (v4)
  logEmail, getEmailLog,
  // audit
  addAuditLog, getAuditLogs,
  // magazines
  getAllMagazines, getMagazine, createMagazine, updateMagazine, deleteMagazine,
  getPages, addPage, addPages, reorderPages, deletePage,
  getAllCovers, createCover, deleteCover,
  // usage
  getTenantUsage,
  // analytics (v4)
  addReaderEvent, getReaderStats, getReaderStatsByMagazine,
  // publish
  snapshotForPublish,
  // utility
  hashPassword, randomToken
};
