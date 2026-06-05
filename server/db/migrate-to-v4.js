// Schema v4 迁移：加 users / plans / subscriptions / invoices / payment_methods /
//                  reader_analytics / signup_tokens / password_reset_tokens / email_log / user_invitations
//                  + tenants 加 logo_url / primary_color / plan_id / subscription_status / trial_ends_at
// 现有 zhuobao admin 自动变成 owner user
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dataPath = path.join(__dirname, 'data.json');
const resultPath = path.join(__dirname, '..', '..', 'tools', 'migrate-v4-result.txt');
const log = [];
function L(s) { log.push(s); }

try {
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  L('BEFORE:');
  L('  tenants: ' + (data.tenants || []).length);
  L('  users: ' + (data.users ? data.users.length : '(none)'));
  L('  plans: ' + (data.plans ? data.plans.length : '(none)'));
  L('  _meta: ' + JSON.stringify(data._meta));

  // 1. 初始化所有 v4 数组
  const v4Arrays = ['users', 'plans', 'subscriptions', 'invoices', 'payment_methods', 'reader_analytics', 'signup_tokens', 'password_reset_tokens', 'email_log', 'user_invitations'];
  v4Arrays.forEach(k => { if (!data[k]) data[k] = []; });

  // 2. 初始化 v4 plans（free / pro / enterprise）
  if (data.plans.length === 0) {
    data.plans = [
      {
        id: 1, slug: 'free', name: '免费版',
        price_monthly_cny: 0,
        features: {
          max_magazines: 3,
          max_pages_per_magazine: 50,
          max_storage_mb: 500,
          has_custom_branding: false,
          has_analytics: false,
          max_users: 1
        }
      },
      {
        id: 2, slug: 'pro', name: '专业版',
        price_monthly_cny: 199,
        features: {
          max_magazines: 30,
          max_pages_per_magazine: 200,
          max_storage_mb: 5000,
          has_custom_branding: true,
          has_analytics: true,
          max_users: 10
        }
      },
      {
        id: 3, slug: 'enterprise', name: '企业版',
        price_monthly_cny: 999,
        features: {
          max_magazines: -1,  // -1 = 不限
          max_pages_per_magazine: -1,
          max_storage_mb: 50000,
          has_custom_branding: true,
          has_analytics: true,
          max_users: -1
        }
      }
    ];
    L('  seeded 3 default plans: free / pro / enterprise');
  }

  // 3. 给所有 tenants 加 v4 字段
  if (!data.tenants) data.tenants = [];
  data.tenants.forEach(t => {
    if (t.logo_url === undefined) t.logo_url = '';
    if (t.primary_color === undefined) t.primary_color = '#4f46e5';
    if (t.plan_id === undefined) t.plan_id = 1;  // 默认 free
    if (t.subscription_status === undefined) t.subscription_status = 'active';
    if (t.trial_ends_at === undefined) t.trial_ends_at = null;
  });

  // 4. 给现有 zhuobao admin 建一个 owner user（兼容老 slug 登录）
  if (data.users.length === 0) {
    const zhuobao = data.tenants.find(t => t.slug === 'zhuobao');
    if (zhuobao) {
      const salt = 'mag-static-salt-v4';
      const passwordHash = crypto.createHash('sha256').update(salt + 'change-me-now').digest('hex');
      data.users.push({
        id: 1,
        tenant_id: zhuobao.id,
        email: 'admin@zhuobao.local',
        password_hash: passwordHash,
        role: 'owner',
        name: '卓宝人管理员',
        status: 'active',
        created_at: new Date().toISOString(),
        last_login_at: null
      });
      L('  created owner user for zhuobao: admin@zhuobao.local (password: change-me-now)');
    }
  }

  // 5. _meta
  if (!data._meta) data._meta = { schema_version: 3, migrated_at: new Date().toISOString() };
  data._meta.schema_version = 4;
  data._meta.migrated_at = new Date().toISOString();

  fs.writeFileSync(dataPath, JSON.stringify(data, null, 2), 'utf8');

  L('AFTER:');
  L('  tenants: ' + data.tenants.length);
  L('  users: ' + data.users.length);
  L('  plans: ' + data.plans.length);
  data.tenants.forEach(t => L('    - id=' + t.id + ' slug=' + t.slug + ' plan_id=' + t.plan_id + ' color=' + t.primary_color));
  data.users.forEach(u => L('    - id=' + u.id + ' email=' + u.email + ' role=' + u.role + ' tenant_id=' + u.tenant_id));
  L('  schema_version: ' + data._meta.schema_version);
  L('MIGRATION OK');
} catch (e) {
  L('ERROR: ' + e.message);
  L(e.stack);
}

fs.mkdirSync(path.dirname(resultPath), { recursive: true });
fs.writeFileSync(resultPath, log.join('\n') + '\n', 'utf8');
process.exit(0);
