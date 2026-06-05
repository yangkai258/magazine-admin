// 鉴权：session-based 密码登录（多租户 + 平台管理员）
// 角色：
//   - 普通租户：登录后只能看/改自己的杂志
//   - 平台管理员 (is_platform_admin=true)：能管所有租户、看所有审计日志
const crypto = require('crypto');
const db = require('./db/init');

const COOKIE_NAME = 'mag_admin_sid';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;  // 24h
const SESSION_TTL_S = SESSION_TTL_MS / 1000;

// 内存 session store（进程重启会失效，可接受；多实例部署再换 Redis）
const sessions = new Map();  // sid -> { tenantId, slug, name, isPlatformAdmin, expiresAt }

function newSid() {
  return crypto.randomBytes(32).toString('hex');
}

function createSession(tenant) {
  const sid = newSid();
  sessions.set(sid, {
    tenantId: tenant.id,
    slug: tenant.slug,
    name: tenant.name,
    isPlatformAdmin: !!tenant.is_platform_admin,
    expiresAt: Date.now() + SESSION_TTL_MS
  });
  return sid;
}

function destroySession(sid) {
  if (sid) sessions.delete(sid);
}

function getSession(sid) {
  if (!sid) return null;
  const s = sessions.get(sid);
  if (!s) return null;
  if (s.expiresAt < Date.now()) {
    sessions.delete(sid);
    return null;
  }
  // 滑动续期
  s.expiresAt = Date.now() + SESSION_TTL_MS;
  return s;
}

// 校验密码：优先用 data.json 里 tenant 的 password（多租户用），
// fallback 到环境变量 ADMIN_PASSWORD（默认租户 bootstrap）
function checkPassword(tenant, providedPassword) {
  if (!tenant || !providedPassword) return false;
  if (tenant.password && tenant.password === providedPassword) return true;
  const envPwd = process.env.ADMIN_PASSWORD;
  if (envPwd && envPwd === providedPassword) return true;
  return false;
}

// 登录：找 tenant by slug，校验 password，写 audit log
function login(slug, password, req) {
  const tenant = db.getTenantBySlug(slug);
  if (!tenant) return { ok: false, error: '租户不存在' };
  if (tenant.suspended) return { ok: false, error: '租户已暂停，请联系平台管理员' };
  if (!checkPassword(tenant, password)) {
    // 失败也记 audit log（方便追查暴力破解）
    db.addAuditLog({
      actor_tenant_slug: slug,
      tenant_id: tenant.id,
      action: 'login_failed',
      ip: req ? req.ip : null,
      user_agent: req ? (req.headers && req.headers['user-agent']) : null
    });
    return { ok: false, error: '密码错误' };
  }
  const sid = createSession(tenant);
  db.addAuditLog({
    actor_tenant_id: tenant.id,
    actor_tenant_slug: tenant.slug,
    actor_is_platform_admin: !!tenant.is_platform_admin,
    tenant_id: tenant.id,
    action: 'login',
    ip: req ? req.ip : null,
    user_agent: req ? (req.headers && req.headers['user-agent']) : null
  });
  return {
    ok: true,
    sid,
    tenant: {
      id: tenant.id,
      slug: tenant.slug,
      name: tenant.name,
      is_platform_admin: !!tenant.is_platform_admin
    }
  };
}

function logout(req) {
  if (req && req.session) {
    db.addAuditLog({
      actor_tenant_id: req.session.tenantId,
      actor_tenant_slug: req.session.slug,
      actor_is_platform_admin: !!req.session.isPlatformAdmin,
      tenant_id: req.session.tenantId,
      action: 'logout',
      ip: req.ip,
      user_agent: req.headers && req.headers['user-agent']
    });
  }
  if (req && req.sid) destroySession(req.sid);
}

// 清理过期 session（每小时跑一次）
setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of sessions.entries()) {
    if (s.expiresAt < now) sessions.delete(sid);
  }
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
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=${sid}; HttpOnly; Path=/; Max-Age=${SESSION_TTL_S}; SameSite=Lax`
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`
  );
}

// 解析 session（不强制要求登录），把结果放 req.session
function attachSession(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  const sid = cookies[COOKIE_NAME];
  const session = getSession(sid);
  req.session = session;
  req.tenant = session ? {
    id: session.tenantId,
    slug: session.slug,
    name: session.name,
    is_platform_admin: !!session.isPlatformAdmin
  } : null;
  req.sid = sid || null;
  next();
}

// 强制登录：未登录返回 401
function requireAuth(req, res, next) {
  if (!req.session) {
    return res.status(401).json({ error: '未登录', code: 'AUTH_REQUIRED' });
  }
  next();
}

// 强制平台管理员：未登录 或 不是 platform admin 都 403
function requirePlatformAdmin(req, res, next) {
  if (!req.session) {
    return res.status(401).json({ error: '未登录', code: 'AUTH_REQUIRED' });
  }
  if (!req.session.isPlatformAdmin) {
    return res.status(403).json({ error: '需要平台管理员权限', code: 'PLATFORM_ADMIN_REQUIRED' });
  }
  next();
}

module.exports = {
  COOKIE_NAME, SESSION_TTL_S,
  login, logout, destroySession, getSession, checkPassword,
  attachSession, requireAuth, requirePlatformAdmin,
  setSessionCookie, clearSessionCookie
};
