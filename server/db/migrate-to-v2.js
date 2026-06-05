// 一次性迁移：data.json 加 tenants 表 + tenant_id 字段
// 跑完即可删
const fs = require('fs');
const path = require('path');

const dataPath = path.join(__dirname, 'data.json');
const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

console.log('BEFORE:');
console.log('  magazines:', data.magazines.length);
console.log('  pages:', data.pages.length);
console.log('  covers:', data.covers.length);
console.log('  tenants:', data.tenants ? data.tenants.length : '(none)');

// 1. 加 tenants 表（如果还没有）
if (!data.tenants) {
  data.tenants = [
    {
      id: 1,
      slug: 'zhuobao',
      name: '卓宝人',
      created_at: new Date().toISOString()
    }
  ];
}

// 2. 给所有 magazines 加 tenant_id=1
data.magazines.forEach(m => {
  if (m.tenant_id === undefined) m.tenant_id = 1;
});

// 3. 给所有 pages 加 tenant_id=1（从 magazine_id 推）
data.pages.forEach(p => {
  if (p.tenant_id === undefined) p.tenant_id = 1;
});

// 4. 给所有 covers 加 tenant_id=1
data.covers.forEach(c => {
  if (c.tenant_id === undefined) c.tenant_id = 1;
});

// 5. 加 schema version（防 future migration 误判）
if (!data._meta) {
  data._meta = { schema_version: 2, migrated_at: new Date().toISOString() };
}

fs.writeFileSync(dataPath, JSON.stringify(data, null, 2), 'utf8');

console.log('AFTER:');
console.log('  tenants:', data.tenants.length);
console.log('  magazines:', data.magazines.length, '(tenant_id=' + data.magazines[0].tenant_id + ')');
console.log('  pages:', data.pages.length, '(tenant_id=' + data.pages[0].tenant_id + ')');
console.log('  covers:', data.covers.length, '(tenant_id=' + data.covers[0].tenant_id + ')');
console.log('  schema_version:', data._meta.schema_version);
console.log('migrated ok.');
