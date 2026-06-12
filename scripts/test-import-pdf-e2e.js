// E2E 模拟 PDF import 链路（不依赖 canvas：走降级路径）
// 1. 重置 admin@zhuobao.local 密码
// 2. 启 admin app
// 3. 登录拿 sid
// 4. POST /api/admin/magazines/import-pdf
// 5. 验 200 + warning + audit + magazine 落库
// 6. 还原 data.json

process.env.MOCK_AI = '1';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');

const ROOT = 'C:\\Users\\YKing\\.openclaw\\workspace\\magazine-admin';
const logPath = path.join(ROOT, 'e2e-mock.log');
fs.writeFileSync(logPath, '');

const dataPath = path.join(ROOT, 'server', 'db', 'data.json');
const backupPath = dataPath + '.e2e-backup-' + Date.now();

function log(s) { fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${s}\n`); }

const RAW = 'TestPass123!';
const SALT = 'mag-static-salt-v4';

let db, server, port, adminUser;

async function main() {
  try {
    fs.copyFileSync(dataPath, backupPath);
    log('backed up data.json to ' + path.basename(backupPath));

    // 重置密码
    db = require(path.join(ROOT, 'server', 'db', 'init'));
    const allUsers = db.getAllUsers({ tenantId: 1 });
    log('tenant 1 users: ' + allUsers.length);
    adminUser = allUsers.find(u => u.email === 'admin@zhuobao.local');
    if (!adminUser) { log('FATAL: admin user not found'); cleanup(1); return; }
    log('admin user: id=' + adminUser.id);
    db.setUserPassword(adminUser.id, RAW);
    log('password reset OK, hash head: ' + (db.getUser(adminUser.id).password_hash || '').slice(0, 16));

    // 启 server
    const admin = require(path.join(ROOT, 'server', 'admin'));
    port = 50220 + Math.floor(Math.random() * 100);
    server = http.createServer(admin);
    await new Promise((resolve) => server.listen(port, () => { log('admin listening on ' + port); resolve(); }));

    // 1. 未登录 → 401
    log('--- 1. POST without login (expect 401) ---');
    const r1 = await postReq(null, 401, 'NO_LOGIN');
    log('  status: ' + r1.status);

    // 2. 登录
    log('--- 2. login ---');
    const auth = require(path.join(ROOT, 'server', 'auth'));
    const loginRes = auth.login('zhuobao', 'admin@zhuobao.local', RAW, { ip: '127.0.0.1', headers: { 'user-agent': 'e2e-test' } });
    if (!loginRes.ok) { log('login FAILED: ' + loginRes.error); cleanup(1); return; }
    log('login OK sid=' + loginRes.sid.slice(0, 12));
    const sid = loginRes.sid;

    // 3. 登录后 POST
    log('--- 3. POST with login (expect 200 + warning due to canvas missing) ---');
    const r3 = await postReq(sid, 200, 'LOGGED_IN');
    log('  status: ' + r3.status);
    let obj = null;
    if (r3.body) {
      try { obj = JSON.parse(r3.body); }
      catch (e) { log('  body parse ERR: ' + e.message); log('  raw: ' + r3.body.slice(0, 500)); }
    }
    if (obj) {
      log('  magazine.id: ' + (obj.magazine && obj.magazine.id));
      log('  pages: ' + (obj.pages ? obj.pages.length : 0));
      log('  pdf_meta.pages_extracted: ' + (obj.pdf_meta && obj.pdf_meta.pages_extracted));
      log('  warning: ' + (obj.warning ? obj.warning.slice(0, 100) : 'none'));
      log('  rate_limit.remaining: ' + (obj.rate_limit && obj.rate_limit.remaining));
    }

    // 4. 验 audit
    log('--- 4. audit_log check ---');
    const allLogs = db.getAuditLogs({ tenantId: 1, action: 'ai_pdf_import', limit: 3 });
    log('  ai_pdf_import entries: ' + allLogs.items.length);
    if (allLogs.items.length > 0) {
      const e = allLogs.items[0];
      log('  latest: ' + JSON.stringify({
        target_id: e.target_id,
        pdf_bytes: e.details.pdf_bytes,
        pdf_pages_count: e.details.pdf_pages_count,
        pdf_parse_warning: e.details.pdf_parse_warning ? 'YES' : 'no',
        ai_warning: e.details.ai_warning ? 'YES' : 'no',
        mock: e.details.mock,
        rate_remaining: e.details.rate_remaining
      }));
    }

    // 5. 验 magazine 落库
    log('--- 5. magazine created check ---');
    const mags = db.getAllMagazines({ tenantId: 1, enabled: 0 });
    log('  draft mags total: ' + mags.length);
    mags.forEach(m => log('    - id=' + m.id + ' name=' + m.name + ' desc=' + m.description.slice(0, 40)));
    const lastPdfMag = mags.filter(m => m.name && (m.name.includes('PDF') || m.description.includes('PDF'))).pop();
    if (lastPdfMag) {
      log('  last PDF mag: id=' + lastPdfMag.id + ' name=' + lastPdfMag.name);
      const ps = db.getPages(lastPdfMag.id, { tenantId: 1 });
      log('  pages: ' + ps.length);
    }

    cleanup(0);
  } catch (e) {
    log('FATAL: ' + e.message);
    log('stack: ' + (e.stack || '').slice(0, 1500));
    cleanup(1);
  }
}

function postReq(sid, expectStatus, tag) {
  return new Promise((resolve) => {
    const fakePdf = Buffer.concat([
      Buffer.from('%PDF-1.4\n%fake 2-page pdf for testing\n%%EOF')
    ]);
    const boundary = '----test' + Date.now();
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="pdf"; filename="test.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
      fakePdf,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);
    const headers = {
      'Content-Type': 'multipart/form-data; boundary=' + boundary,
      'Content-Length': body.length
    };
    if (sid) headers['Cookie'] = 'mag_admin_sid=' + sid;
    const req = http.request({
      hostname: '127.0.0.1', port,
      path: '/api/admin/magazines/import-pdf',
      method: 'POST',
      headers
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const ok = res.statusCode === expectStatus;
        log(`  [${tag}] status=${res.statusCode} (expect ${expectStatus}) ${ok ? 'OK' : 'MISMATCH'}`);
        if (!ok) log(`  [${tag}] body: ${text.slice(0, 1500)}`);
        resolve({ status: res.statusCode, body: text });
      });
    });
    req.on('error', (e) => { log(`  [${tag}] REQ ERR: ${e.message}`); resolve({ status: 0, body: null }); });
    req.write(body);
    req.end();
  });
}

function cleanup(code) {
  if (server) try { server.close(); } catch (_) {}
  if (fs.existsSync(backupPath)) {
    try { fs.copyFileSync(backupPath, dataPath); fs.unlinkSync(backupPath); log('restored data.json'); } catch (e) { log('restore ERR: ' + e.message); }
  }
  setTimeout(() => process.exit(code), 100);
}

main();
