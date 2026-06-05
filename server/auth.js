// 鉴权：session-based 密码登录（多租户预留）
// 现在：单一环境变量 ADMIN_PASSWORD 作为默认租户（zhuobao）的密码
// 未来：每个 tenant 自己的 password 字段（已预留 verifyTenantPassword）
const crypto = require('crypto');
const db = require('./db/init');

const COOKIE_NAME = 'mag_admin_sid';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;  // 24h
const SESSION_TTL_S = SESSION_TTL_MS / 1000;

// 内存 session store（进程重启会失效，可接受；多实例部署再换 Redis）
const sessions = new Map();  // sid -> { tenantId, slug, name, expiresAt }

function newSid() {
  return crypto.randomBytes(32).toString('hex');
}

function createSession(tenant) {
  const sid = newSid();
  sessions.set(sid, {
    tenantId: tenant.id,
    slug: tenant.slug,
    name: tenant.name,
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

// 校验密码：优先用 data.json 里 tenant 的 password（多租户时代用），
// fallback 到环境变量 ADMIN_PASSWORD（默认租户 bootstrap）
function checkPassword(tenant, providedPassword) {
  if (!tenant || !providedPassword) return false;
  if (tenant.password && tenant.password === providedPassword) return true;
  // fallback 到环境变量
  const envPwd = process.env.ADMIN_PASSWORD;
  if (envPwd && envPwd === providedPassword) return true;
  return false;
}

// 登录：找 tenant by slug，校验 password
function login(slug, password) {
  const tenant = db.getTenantBySlug(slug);
  if (!tenant) return { ok: false, error: '租户不存在' };
  if (!checkPassword(tenant, password)) return { ok: false, error: '密码错误' };
  const sid = createSession(tenant);
  return { ok: true, sid, tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name } };
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
  req.tenant = session ? { id: session.tenantId, slug: session.slug, name: session.name } : null;
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

module.exports = {
  COOKIE_NAME, SESSION_TTL_S,
  login, destroySession, getSession, checkPassword,
  attachSession, requireAuth, setSessionCookie, clearSessionCookie
};
