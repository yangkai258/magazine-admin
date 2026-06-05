// 鉴权：基于 user 的 session（v4）
// 用户用 email 登录，租户通过 tenant_id 隔离，角色 owner/editor/viewer
// 平台管理员：所属 tenant.is_platform_admin=true
const crypto = require('crypto');
const db = require('./db/init');

const COOKIE_NAME = 'mag_admin_sid';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;  // 24h
const SESSION_TTL_S = SESSION_TTL_MS / 1000;

// 内存 session store
// sid -> { userId, tenantId, tenantSlug, tenantName, isPlatformAdmin, role, email, name, expiresAt }
const sessions = new Map();

function newSid() { return crypto.randomBytes(32).toString('hex'); }

function createSession(user, tenant) {
  const sid = newSid();
  sessions.set(sid, {
    userId: user.id,
    userEmail: user.email,
    userName: user.name,
    userRole: user.role,
    tenantId: tenant.id,
    tenantSlug: tenant.slug,
    tenantName: tenant.name,
    tenantLogo: tenant.logo_url || '',
    tenantPrimaryColor: tenant.primary_color || '#4f46e5',
    isPlatformAdmin: !!tenant.is_platform_admin,
    expiresAt: Date.now() + SESSION_TTL_MS
  });
  return sid;
}

function destroySession(sid) { if (sid) sessions.delete(sid); }

function getSession(sid) {
  if (!sid) return null;
  const s = sessions.get(sid);
  if (!s) return null;
  if (s.expiresAt < Date.now()) { sessions.delete(sid); return null; }
  s.expiresAt = Date.now() + SESSION_TTL_MS;  // 滑动续期
  return s;
}

// 登录：找 tenant（slug 或 id），找 user by email，校验 password
function login(tenantSlug, email, password, req) {
  let tenant = null;
  if (tenantSlug) tenant = db.getTenantBySlug(tenantSlug);
  if (!tenant && email && email.includes('@')) {
    // 试用 email 找：拆分 email（user@tenant-slug.local）— 暂不支持，强制要 slug
    return { ok: false, error: '需要先选择租户' };
  }
  if (!tenant) return { ok: false, error: '租户不存在' };
  if (tenant.suspended) return { ok: false, error: '租户已暂停，请联系平台管理员' };

  // 兼容 v3 老流程：tenant-level password（如果 users 表里没人）
  if (db.getAllUsers({ tenantId: tenant.id }).length === 0 && tenant.password) {
    if (tenant.password !== password) {
      db.addAuditLog({ actor_tenant_id: tenant.id, actor_tenant_slug: tenant.slug, tenant_id: tenant.id, action: 'login_failed', details: { reason: 'no_users_tenant_password', email }, ip: req ? req.ip : null, user_agent: req ? (req.headers && req.headers['user-agent']) : null });
      return { ok: false, error: '密码错误' };
    }
    // 用 tenant-level password 登录，自动建一个 owner user 关联这次登录
    const oldUser = {
      id: 0, email: email || '__tenant_legacy__', name: 'Legacy Admin', role: 'owner'
    };
    const sid = createSession({ ...oldUser, tenant_id: tenant.id }, tenant);
    db.addAuditLog({ actor_tenant_id: tenant.id, actor_tenant_slug: tenant.slug, actor_is_platform_admin: !!tenant.is_platform_admin, tenant_id: tenant.id, action: 'login', details: { via: 'tenant_legacy_password' }, ip: req ? req.ip : null, user_agent: req ? (req.headers && req.headers['user-agent']) : null });
    return { ok: true, sid, tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name, is_platform_admin: !!tenant.is_platform_admin, logo_url: tenant.logo_url, primary_color: tenant.primary_color }, user: oldUser };
  }

  // v4 流程：email + password
  if (!email) return { ok: false, error: '需要 email' };
  const user = db.verifyUserPassword(tenant.id, email, password);
  if (!user) {
    db.addAuditLog({ actor_tenant_id: tenant.id, actor_tenant_slug: tenant.slug, tenant_id: tenant.id, action: 'login_failed', details: { reason: 'bad_password', email }, ip: req ? req.ip : null, user_agent: req ? (req.headers && req.headers['user-agent']) : null });
    return { ok: false, error: '邮箱或密码错误' };
  }
  // 更新 last_login_at
  db.updateUser(user.id, { last_login_at: new Date().toISOString() });
  const sid = createSession(user, tenant);
  db.addAuditLog({
    actor_user_id: user.id, actor_user_email: user.email, actor_role: user.role,
    actor_tenant_id: tenant.id, actor_tenant_slug: tenant.slug, actor_is_platform_admin: !!tenant.is_platform_admin,
    tenant_id: tenant.id, action: 'login',
    ip: req ? req.ip : null, user_agent: req ? (req.headers && req.headers['user-agent']) : null
  });
  return {
    ok: true, sid,
    tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name, is_platform_admin: !!tenant.is_platform_admin, logo_url: tenant.logo_url, primary_color: tenant.primary_color },
    user: { id: user.id, email: user.email, name: user.name, role: user.role }
  };
}

function logout(req) {
  if (req && req.session) {
    db.addAuditLog({
      actor_user_id: req.session.userId, actor_user_email: req.session.userEmail, actor_role: req.session.userRole,
      actor_tenant_id: req.session.tenantId, actor_tenant_slug: req.session.tenantSlug, actor_is_platform_admin: !!req.session.isPlatformAdmin,
      tenant_id: req.session.tenantId, action: 'logout',
      ip: req.ip, user_agent: req.headers && req.headers['user-agent']
    });
  }
  if (req && req.sid) destroySession(req.sid);
}

// 清理过期 session
setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of sessions.entries()) if (s.expiresAt < now) sessions.delete(sid);
}, 60 * 60 * 1000).unref();

// ========== Express middleware ==========
function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (!k) continue;
    cookies[k] = decodeURIComponent(rest.join('='));
  }
  return cookies;
}

function setSessionCookie(res, sid) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${sid}; HttpOnly; Path=/; Max-Age=${SESSION_TTL_S}; SameSite=Lax`);
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
}

function attachSession(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  const sid = cookies[COOKIE_NAME];
  const session = getSession(sid);
  req.session = session;
  req.tenant = session ? {
    id: session.tenantId,
    slug: session.tenantSlug,
    name: session.tenantName,
    is_platform_admin: !!session.isPlatformAdmin,
    // 品牌：session 在 login 时已写入（createSession 第 27-28 行），这里透出到 /api/auth/me
    // 注意：session 是 login 时缓存的，用户改品牌后需重新登录才能从 /me 拿到新值。
    // 客户端如需拿最新值，应改调 GET /api/admin/branding（不依赖 session 缓存）。
    logo_url: session.tenantLogo || '',
    primary_color: session.tenantPrimaryColor || '#4f46e5'
  } : null;
  req.user = session ? {
    id: session.userId,
    email: session.userEmail,
    name: session.userName,
    role: session.userRole
  } : null;
  req.sid = sid || null;
  next();
}

function requireAuth(req, res, next) {
  if (!req.session) return res.status(401).json({ error: '未登录', code: 'AUTH_REQUIRED' });
  next();
}

function requirePlatformAdmin(req, res, next) {
  if (!req.session) return res.status(401).json({ error: '未登录', code: 'AUTH_REQUIRED' });
  if (!req.session.isPlatformAdmin) return res.status(403).json({ error: '需要平台管理员权限', code: 'PLATFORM_ADMIN_REQUIRED' });
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session) return res.status(401).json({ error: '未登录', code: 'AUTH_REQUIRED' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: `需要角色 ${roles.join('/')}`, code: 'ROLE_REQUIRED', current_role: req.user.role });
    }
    next();
  };
}

// audit 工具
function audit(req, action, opts) {
  if (!req.session) return;
  const actor = {
    actor_user_id: req.user.id,
    actor_user_email: req.user.email,
    actor_role: req.user.role,
    actor_tenant_id: req.tenant.id,
    actor_tenant_slug: req.tenant.slug,
    actor_is_platform_admin: !!req.tenant.is_platform_admin
  };
  const entry = Object.assign({
    tenant_id: req.tenant ? req.tenant.id : null,
    action,
    ip: req.ip,
    user_agent: req.headers && req.headers['user-agent']
  }, actor, opts || {});
  db.addAuditLog(entry);
}

module.exports = {
  COOKIE_NAME, SESSION_TTL_S,
  login, logout, destroySession, getSession,
  attachSession, requireAuth, requirePlatformAdmin, requireRole,
  setSessionCookie, clearSessionCookie, audit
};
