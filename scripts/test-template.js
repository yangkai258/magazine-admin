// scripts/test-template.js
//
// 用途：v6.3 模板系统的离线 smoke test（不依赖 server 起来）
//   1. 校验 server/templates.js 模块加载 + 接口签名
//   2. 3 套内置模板的 schema 完整性（必填字段 + 合法枚举值）
//   3. buildPreview() 行为：3 套模板各自生成、fallback、overrides 合并
//   4. 防御：未知 id / 损坏 overrides / null 模板 id / overrides 是非 object 的降级
//   5. server/admin.js 的 3 个端点 wired（用 supertest 风格手写 stub；不依赖 express 起来）
//   6. server/db/init.js 兼容：magazine 缺 template_id 字段时 backfill 为 null
//
// 用法：
//   node scripts/test-template.js
//
// 退出码：0 全过 / 1 有失败
// 沙箱期望：纯 Node.js + 模块加载 + 函数调用，无需起 server

'use strict';
process.env.MOCK_AI = '1';  // 显式声明以防万一

const fs = require('fs');
const path = require('path');
const http = require('http');
const ROOT = path.join(__dirname, '..');

// ---------- 工具：日志到文件（sandbox 不一定能 print stdout） ----------
const LOG_PATH = path.join(ROOT, '_test_template.log');
function log(s) {
  process.stdout.write(s + '\n');
  try { fs.appendFileSync(LOG_PATH, s + '\n', 'utf8'); } catch (_) {}
}
function assert(cond, msg) {
  if (!cond) { log('  FAIL: ' + msg); return false; }
  log('  OK: ' + msg);
  return true;
}
function resetLog() { try { fs.writeFileSync(LOG_PATH, '', 'utf8'); } catch (_) {} }

// ---------- 1. 模块加载 + 接口签名 ----------
function case1_load() {
  log('\n[1] load server/templates.js + 接口签名');
  const t = require(path.join(ROOT, 'server', 'templates'));
  let pass = 0, fail = 0;
  const tally = (ok) => ok ? pass++ : fail++;
  tally(assert(typeof t.listTemplates === 'function', 'listTemplates is a function'));
  tally(assert(typeof t.getTemplate === 'function', 'getTemplate is a function'));
  tally(assert(typeof t.isValidTemplateId === 'function', 'isValidTemplateId is a function'));
  tally(assert(typeof t.buildPreview === 'function', 'buildPreview is a function'));
  tally(assert(typeof t.listTemplateIds === 'function', 'listTemplateIds is a function'));
  tally(assert(t._internal && t._internal.FALLBACK_TEMPLATE_ID === 'business', '_internal.FALLBACK_TEMPLATE_ID === "business"'));
  return { pass, fail };
}

// ---------- 2. 3 套内置模板的 schema 完整性 ----------
function case2_schema() {
  log('\n[2] 3 套内置模板的 schema 完整性');
  const t = require(path.join(ROOT, 'server', 'templates'));
  const list = t.listTemplates();
  let pass = 0, fail = 0;
  const tally = (ok) => ok ? pass++ : fail++;

  tally(assert(list.length === 3, 'listTemplates() returns exactly 3 templates (got ' + list.length + ')'));
  const ids = list.map(x => x.id);
  tally(assert(ids.includes('business') && ids.includes('education') && ids.includes('minimal'), 'all 3 ids present: ' + ids.join(', ')));

  // 每套模板必填字段
  list.forEach((tmpl, i) => {
    tally(assert(typeof tmpl.id === 'string' && tmpl.id, '[' + i + '] id is non-empty string: ' + tmpl.id));
    tally(assert(typeof tmpl.name === 'string' && tmpl.name, '[' + i + '] name is non-empty string: ' + tmpl.name));
    tally(assert(typeof tmpl.description === 'string' && tmpl.description, '[' + i + '] description is non-empty string'));
    // colors
    tally(assert(tmpl.colors && typeof tmpl.colors === 'object', '[' + i + '] colors is object'));
    ['primary', 'accent', 'bg', 'text'].forEach(k => {
      tally(assert(typeof tmpl.colors[k] === 'string' && /^#[0-9A-Fa-f]{6}$/.test(tmpl.colors[k]),
        '[' + i + '] colors.' + k + ' is #RRGGBB hex: ' + tmpl.colors[k]));
    });
    // fonts
    tally(assert(tmpl.fonts && typeof tmpl.fonts === 'object', '[' + i + '] fonts is object'));
    tally(assert(typeof tmpl.fonts.heading === 'string' && tmpl.fonts.heading, '[' + i + '] fonts.heading is non-empty string'));
    tally(assert(typeof tmpl.fonts.body === 'string' && tmpl.fonts.body, '[' + i + '] fonts.body is non-empty string'));
    // layout
    tally(assert(tmpl.layout && typeof tmpl.layout === 'object', '[' + i + '] layout is object'));
    tally(assert(['banner', 'full', 'split'].includes(tmpl.layout.coverStyle), '[' + i + '] layout.coverStyle valid: ' + tmpl.layout.coverStyle));
    tally(assert(['simple', 'line', 'none'].includes(tmpl.layout.footerStyle), '[' + i + '] layout.footerStyle valid: ' + tmpl.layout.footerStyle));
    // elements
    tally(assert(tmpl.elements && typeof tmpl.elements === 'object', '[' + i + '] elements is object'));
    tally(assert(['star', 'arrow', 'book', 'none'].includes(tmpl.elements.iconSet), '[' + i + '] elements.iconSet valid: ' + tmpl.elements.iconSet));
    tally(assert(['line', 'dots', 'wave'].includes(tmpl.elements.divider), '[' + i + '] elements.divider valid: ' + tmpl.elements.divider));
    tally(assert(['rounded', 'sharp', 'none'].includes(tmpl.elements.card), '[' + i + '] elements.card valid: ' + tmpl.elements.card));
  });

  // 设计意图：商务深蓝 / 教育暖橙 / 极简黑
  const biz = t.getTemplate('business');
  tally(assert(biz.colors.primary === '#1E3A8A', 'business primary is #1E3A8A'));
  const edu = t.getTemplate('education');
  tally(assert(edu.colors.primary === '#EA580C', 'education primary is #EA580C'));
  const min = t.getTemplate('minimal');
  tally(assert(min.colors.primary === '#111827', 'minimal primary is #111827'));

  // 不可变
  tally(assert(Object.isFrozen(t.listTemplates()[0]), 'templates are frozen (Object.freeze)'));
  return { pass, fail };
}

// ---------- 3. buildPreview 行为 ----------
function case3_buildPreview() {
  log('\n[3] buildPreview() 行为：3 套模板 + fallback + overrides 合并');
  const t = require(path.join(ROOT, 'server', 'templates'));
  let pass = 0, fail = 0;
  const tally = (ok) => ok ? pass++ : fail++;

  // 3 套模板各自生成
  ['business', 'education', 'minimal'].forEach(id => {
    const p = t.buildPreview(id);
    tally(assert(p.template_id === id, '[' + id + '] template_id === "' + id + '"'));
    tally(assert(typeof p.template_name === 'string' && p.template_name, '[' + id + '] template_name is non-empty'));
    tally(assert(p.css_vars && typeof p.css_vars === 'object', '[' + id + '] css_vars is object'));
    tally(assert(p.element_classes && typeof p.element_classes === 'object', '[' + id + '] element_classes is object'));
    // 4 colors 都有
    ['--template-color-primary', '--template-color-accent', '--template-color-bg', '--template-color-text'].forEach(k => {
      tally(assert(typeof p.css_vars[k] === 'string' && p.css_vars[k], '[' + id + '] css_vars.' + k + ' is non-empty string: ' + p.css_vars[k]));
    });
    // 2 fonts 都有
    ['--template-font-heading', '--template-font-body'].forEach(k => {
      tally(assert(typeof p.css_vars[k] === 'string' && p.css_vars[k], '[' + id + '] css_vars.' + k + ' is non-empty string'));
    });
    // element_classes 5 个键
    ['cover', 'footer', 'icon', 'divider', 'card'].forEach(k => {
      tally(assert(typeof p.element_classes[k] === 'string' && p.element_classes[k].startsWith('tpl-'),
        '[' + id + '] element_classes.' + k + ' is tpl-* class: ' + p.element_classes[k]));
    });
  });

  // fallback：未知 id → business
  const fb1 = t.buildPreview('non-existent-id');
  tally(assert(fb1.template_id === 'business', 'unknown id falls back to business'));
  // fallback：null id
  const fb2 = t.buildPreview(null);
  tally(assert(fb2.template_id === 'business', 'null id falls back to business'));
  // fallback：undefined id
  const fb3 = t.buildPreview(undefined);
  tally(assert(fb3.template_id === 'business', 'undefined id falls back to business'));
  // fallback：非 string id（number）
  const fb4 = t.buildPreview(42);
  tally(assert(fb4.template_id === 'business', 'non-string id falls back to business'));

  // overrides：颜色覆盖
  const ov1 = t.buildPreview('business', { colors: { primary: '#FF0000' } });
  tally(assert(ov1.css_vars['--template-color-primary'] === '#FF0000', 'overrides colors.primary wins'));
  tally(assert(ov1.css_vars['--template-color-accent'] === '#0EA5E9', 'overrides colors.primary does NOT touch accent'));

  // overrides：layout 覆盖
  const ov2 = t.buildPreview('business', { layout: { coverStyle: 'full' } });
  tally(assert(ov2.css_vars['--template-layout-cover-style'] === 'full', 'overrides layout.coverStyle wins'));
  tally(assert(ov2.element_classes.cover === 'tpl-cover-full', 'overrides layout.coverStyle updates element_classes.cover'));

  // overrides：elements 覆盖
  const ov3 = t.buildPreview('education', { elements: { iconSet: 'star' } });
  tally(assert(ov3.element_classes.icon === 'tpl-icon-star', 'overrides elements.iconSet wins'));

  // overrides：空字符串 / undefined 字段不覆盖
  const ov4 = t.buildPreview('business', { colors: { primary: '' }, name: '' });
  tally(assert(ov4.css_vars['--template-color-primary'] === '#1E3A8A', 'empty string override does NOT overwrite'));
  tally(assert(ov4.template_name === '商务深蓝', 'empty string name override does NOT overwrite template_name'));

  // overrides：损坏类型（数组）
  const ov5 = t.buildPreview('business', ['not', 'an', 'object']);
  tally(assert(ov5.template_id === 'business', 'array overrides falls back gracefully (no crash)'));

  return { pass, fail };
}

// ---------- 4. 防御 / 异常路径 ----------
function case4_defensive() {
  log('\n[4] 防御 / 异常路径');
  const t = require(path.join(ROOT, 'server', 'templates'));
  let pass = 0, fail = 0;
  const tally = (ok) => ok ? pass++ : fail++;

  // isValidTemplateId
  tally(assert(t.isValidTemplateId('business') === true, 'isValidTemplateId(business) === true'));
  tally(assert(t.isValidTemplateId('education') === true, 'isValidTemplateId(education) === true'));
  tally(assert(t.isValidTemplateId('minimal') === true, 'isValidTemplateId(minimal) === true'));
  tally(assert(t.isValidTemplateId('unknown') === false, 'isValidTemplateId(unknown) === false'));
  tally(assert(t.isValidTemplateId('') === false, 'isValidTemplateId("") === false'));
  tally(assert(t.isValidTemplateId(null) === false, 'isValidTemplateId(null) === false'));
  tally(assert(t.isValidTemplateId(undefined) === false, 'isValidTemplateId(undefined) === false'));

  // getTemplate
  tally(assert(t.getTemplate('business') !== null, 'getTemplate(business) is non-null'));
  tally(assert(t.getTemplate('unknown') === null, 'getTemplate(unknown) is null'));
  tally(assert(t.getTemplate(null) === null, 'getTemplate(null) is null'));
  tally(assert(t.getTemplate(42) === null, 'getTemplate(42) is null'));

  // listTemplateIds
  const ids = t.listTemplateIds();
  tally(assert(ids.length === 3 && ids.includes('business') && ids.includes('education') && ids.includes('minimal'),
    'listTemplateIds returns 3 valid ids'));

  // XSS 防御：overrides 里塞 <script>
  const xss = t.buildPreview('business', { name: '<script>alert(1)</script>' });
  // 顶层 name 不存在，XSS 不应渗到 css_vars
  tally(assert(!JSON.stringify(xss.css_vars).includes('<script>'), 'css_vars does not contain <script> from overrides'));
  // 即便渗入，截断到 200 字符
  const long = t.buildPreview('business', { colors: { primary: '#000000'.repeat(100) } });
  tally(assert(long.css_vars['--template-color-primary'].length <= 200, 'overrides string truncated to 200 chars'));

  return { pass, fail };
}

// ---------- 5. server/db/init.js 兼容：magazine 缺 template_id 时 backfill 为 null ----------
//     这里走「module reload + 看内存数据」—— 不动 data.json（sandbox 限制）
function case5_dbCompat() {
  log('\n[5] server/db/init.js 兼容：magazine 缺 template_id 时 backfill 为 null');
  let pass = 0, fail = 0;
  const tally = (ok) => ok ? pass++ : fail++;

  const db = require(path.join(ROOT, 'server', 'db', 'init'));
  // 直接拿所有杂志，验证每条都有 template_id 字段（即便原数据是 undefined，也被 backfill 成 null）
  const mags = db.getAllMagazines();
  tally(assert(Array.isArray(mags) && mags.length > 0, 'getAllMagazines returns non-empty array (count=' + mags.length + ')'));
  let allHaveTemplateId = true;
  let nullCount = 0;
  mags.forEach((m, i) => {
    if (!('template_id' in m)) { allHaveTemplateId = false; }
    if (m.template_id === null) { nullCount += 1; }
  });
  tally(assert(allHaveTemplateId, 'every magazine has template_id field (no undefined)'));
  log('  magazines with template_id === null: ' + nullCount + ' / ' + mags.length + ' (expected all 3 from live data)');
  tally(assert(nullCount === mags.length, 'all existing magazines have template_id === null (no template selected)'));
  return { pass, fail };
}

// ---------- 6. server/admin.js 端点 wired（手写 stub 起 express app） ----------
//     思路：不依赖完整 server 起来；require admin.js（导出 app），用 supertest 替代品——
//     这里我们用 http.createServer(app) + axios-less 写法（Node 自带 fetch）发请求
async function case6_endpoints() {
  log('\n[6] server/admin.js 3 个端点 wired');
  let pass = 0, fail = 0;
  const tally = (ok) => ok ? pass++ : fail++;

  // 先 stub express listening：直接 require admin.js → 它导出 app
  const app = require(path.join(ROOT, 'server', 'admin'));
  // 起 server 监听一个随机端口
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.once('error', reject);
  });
  const port = server.address().port;
  const baseUrl = 'http://127.0.0.1:' + port;
  log('  stub server listening on ' + baseUrl);

  try {
    // 6.1 GET /api/admin/templates —— 无 session → 401
    {
      const r = await fetch(baseUrl + '/api/admin/templates');
      tally(assert(r.status === 401, 'GET /api/admin/templates (no auth) → 401 (got ' + r.status + ')'));
    }

    // 6.2 GET /api/admin/magazines/1/template-preview —— 无 session → 401
    {
      const r = await fetch(baseUrl + '/api/admin/magazines/1/template-preview');
      tally(assert(r.status === 401, 'GET /api/admin/magazines/1/template-preview (no auth) → 401 (got ' + r.status + ')'));
    }

    // 6.3 PUT /api/admin/magazines/1/template —— 无 session → 401
    {
      const r = await fetch(baseUrl + '/api/admin/magazines/1/template', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template_id: 'business' })
      });
      tally(assert(r.status === 401, 'PUT /api/admin/magazines/1/template (no auth) → 401 (got ' + r.status + ')'));
    }

    // 6.4 创建 session 登录后测：先建一个 owner user（如果不存在），登录拿 sid
    const db = require(path.join(ROOT, 'server', 'db', 'init'));
    const auth = require(path.join(ROOT, 'server', 'auth'));
    const email = 'tester-' + Date.now() + '@verify.local';
    const password = 'TestPass123!';

    // 找现成租户
    const tenants = db.getAllTenants();
    const tenant = tenants[0];
    tally(assert(!!tenant, 'got a tenant for auth (id=' + (tenant && tenant.id) + ')'));

    try {
      db.createUser({ tenant_id: tenant.id, email, password, role: 'owner', name: 'Template Tester' });
    } catch (e) {
      log('  (user may already exist: ' + e.message + ')');
    }

    // 登录拿 sid
    const loginRes = await fetch(baseUrl + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: tenant.slug, email, password })
    });
    const setCookie = loginRes.headers.get('set-cookie') || '';
    tally(assert(loginRes.status === 200, 'POST /api/auth/login → 200 (got ' + loginRes.status + ')'));
    const sidMatch = setCookie.match(/mag_admin_sid=([^;]+)/);
    tally(assert(!!sidMatch, 'login set mag_admin_sid cookie'));
    const sid = sidMatch ? sidMatch[1] : '';
    const cookieHeader = 'mag_admin_sid=' + sid;

    // 6.5 GET /api/admin/templates（已登录）→ 200 + 3 套
    {
      const r = await fetch(baseUrl + '/api/admin/templates', { headers: { 'Cookie': cookieHeader } });
      const body = await r.json();
      tally(assert(r.status === 200, 'GET /api/admin/templates (auth) → 200 (got ' + r.status + ')'));
      tally(assert(Array.isArray(body) && body.length === 3, 'returned 3 templates (got ' + body.length + ')'));
      if (Array.isArray(body) && body.length === 3) {
        const ids = body.map(x => x.id).sort();
        tally(assert(ids.join(',') === 'business,education,minimal', 'returned ids are business,education,minimal (got ' + ids.join(',') + ')'));
        const sample = body[0];
        tally(assert(typeof sample.colors === 'object' && typeof sample.fonts === 'object',
          'sample template exposes colors + fonts'));
      }
    }

    // 6.6 PUT 合法 template_id → 200
    const targetMag = db.getAllMagazines({ tenantId: tenant.id })[0];
    tally(assert(!!targetMag, 'got a magazine to mutate (id=' + (targetMag && targetMag.id) + ')'));
    if (targetMag) {
      const r = await fetch(baseUrl + '/api/admin/magazines/' + targetMag.id + '/template', {
        method: 'PUT',
        headers: { 'Cookie': cookieHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({ template_id: 'education' })
      });
      const body = await r.json();
      tally(assert(r.status === 200, 'PUT valid template_id → 200 (got ' + r.status + ')'));
      tally(assert(body.template_id === 'education', 'response body has template_id=education'));
      tally(assert(body.preview && body.preview.template_id === 'education', 'response includes preview with correct template_id'));
      tally(assert(typeof body.preview.css_vars === 'object' && typeof body.preview.element_classes === 'object', 'preview has css_vars + element_classes'));
      // 验证 data.json 确实写入
      const reread = db.getMagazine(targetMag.id, { tenantId: tenant.id });
      tally(assert(reread.template_id === 'education', 'data.json magazine.template_id is now "education"'));
    }

    // 6.7 PUT 非法 template_id → 400
    {
      const r = await fetch(baseUrl + '/api/admin/magazines/' + targetMag.id + '/template', {
        method: 'PUT',
        headers: { 'Cookie': cookieHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({ template_id: 'non-existent' })
      });
      const body = await r.json();
      tally(assert(r.status === 400, 'PUT invalid template_id → 400 (got ' + r.status + ')'));
      tally(assert(body.valid_ids && Array.isArray(body.valid_ids), '400 body includes valid_ids array'));
    }

    // 6.8 PUT overrides 是数组 → 400
    {
      const r = await fetch(baseUrl + '/api/admin/magazines/' + targetMag.id + '/template', {
        method: 'PUT',
        headers: { 'Cookie': cookieHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({ template_id: 'business', overrides: ['bad'] })
      });
      tally(assert(r.status === 400, 'PUT overrides is array → 400 (got ' + r.status + ')'));
    }

    // 6.9 GET template-preview → 200，返 css_vars + element_classes
    {
      const r = await fetch(baseUrl + '/api/admin/magazines/' + targetMag.id + '/template-preview', { headers: { 'Cookie': cookieHeader } });
      const body = await r.json();
      tally(assert(r.status === 200, 'GET template-preview (auth) → 200 (got ' + r.status + ')'));
      tally(assert(body.template_id === 'education', 'preview reflects current template_id (education)'));
      tally(assert(typeof body.css_vars === 'object', 'preview has css_vars object'));
      tally(assert(typeof body.element_classes === 'object', 'preview has element_classes object'));
    }

    // 6.10 GET template-preview with overrides query → 200 + 临时主色变更
    {
      const r = await fetch(baseUrl + '/api/admin/magazines/' + targetMag.id + '/template-preview?overrides=' + encodeURIComponent('{"colors":{"primary":"#FF00FF"}}'), { headers: { 'Cookie': cookieHeader } });
      const body = await r.json();
      tally(assert(r.status === 200, 'preview with overrides query → 200'));
      tally(assert(body.css_vars['--template-color-primary'] === '#FF00FF', 'overrides primary wins in query preview'));
    }

    // 6.11 cleanup: 把 magazine.template_id 还原为 null
    db.updateMagazine(targetMag.id, { template_id: null }, { tenantId: tenant.id });
    // 删测试 user（不删也行，下次跑会复用；先尝试）
    try {
      const u = db.getUserByEmail(tenant.id, email);
      if (u) db.deleteUser(u.id);
    } catch (_) {}

  } finally {
    server.close();
  }
  return { pass, fail };
}

// ---------- main ----------
async function main() {
  resetLog();
  log('=== test-template.js (v6.3 模板系统) ===');
  log('cwd: ' + ROOT);
  let totalPass = 0, totalFail = 0;
  const tallyAll = (r) => { totalPass += r.pass; totalFail += r.fail; };

  tallyAll(case1_load());
  tallyAll(case2_schema());
  tallyAll(case3_buildPreview());
  tallyAll(case4_defensive());
  tallyAll(case5_dbCompat());
  await case6_endpoints().then(r => tallyAll(r)).catch(e => {
    log('[6] unhandled: ' + (e && e.stack ? e.stack : e));
    totalFail += 1;
  });

  log('\n=== summary: ' + totalPass + ' passed, ' + totalFail + ' failed ===');
  log('(also written to ' + LOG_PATH + ')');
  process.exit(totalFail === 0 ? 0 : 1);
}

main().catch(e => { log('UNHANDLED: ' + (e && e.stack ? e.stack : e)); process.exit(1); });
