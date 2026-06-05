// Schema v3 迁移：加 is_platform_admin / suspended 字段 + audit_log 表
// 跑完即可删
const fs = require('fs');
const path = require('path');

const dataPath = path.join(__dirname, 'data.json');
const resultPath = path.join(__dirname, '..', '..', 'tools', 'migrate-v3-result.txt');
const log = [];
function L(s) { log.push(s); }

try {
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  L('BEFORE:');
  L('  tenants: ' + (data.tenants || []).length);
  L('  audit_log: ' + (data.audit_log ? data.audit_log.length : '(none)'));

  // 1. 初始化 audit_log
  if (!data.audit_log) data.audit_log = [];

  // 2. 给所有 tenants 补 is_platform_admin / suspended 字段
  if (!data.tenants) data.tenants = [];
  data.tenants.forEach(t => {
    if (t.is_platform_admin === undefined) t.is_platform_admin = false;
    if (t.suspended === undefined) t.suspended = false;
  });

  // 3. 第一个 tenant 自动成为平台管理员（仅当当前没有任何 platform admin）
  const hasPlatformAdmin = data.tenants.some(t => t.is_platform_admin);
  if (!hasPlatformAdmin && data.tenants.length > 0) {
    data.tenants[0].is_platform_admin = true;
    L('  promoted first tenant to platform admin: ' + data.tenants[0].slug);
  }

  // 4. _meta schema_version
  if (!data._meta) data._meta = { schema_version: 2, migrated_at: new Date().toISOString() };
  data._meta.schema_version = 3;
  data._meta.migrated_at = new Date().toISOString();

  fs.writeFileSync(dataPath, JSON.stringify(data, null, 2), 'utf8');

  L('AFTER:');
  L('  tenants: ' + data.tenants.length);
  data.tenants.forEach(t => L('    - id=' + t.id + ' slug=' + t.slug + ' platform_admin=' + t.is_platform_admin + ' suspended=' + t.suspended));
  L('  audit_log: ' + data.audit_log.length);
  L('  schema_version: ' + data._meta.schema_version);
  L('MIGRATION OK');
} catch (e) {
  L('ERROR: ' + e.message);
  L(e.stack);
}

fs.mkdirSync(path.dirname(resultPath), { recursive: true });
fs.writeFileSync(resultPath, log.join('\n') + '\n', 'utf8');
process.exit(0);
