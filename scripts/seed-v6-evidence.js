// scripts/seed-v6-evidence.js
// v6.1 任务：补 v6.0 live data evidence
// 1 个 AI 草稿杂志（enabled:0）+ 6 个 is_skeleton:true page
// + 1 条 audit_log 记录（action=ai_generate_skeleton）
// + 1 条 reader_analytics 记录（view 事件）
// 全部用 server/db/init.js 的官方 API 写入
// 同时把日志写到 server/db/seed-v6.log（sandbox 里 stdout 不可见）
const path = require('path');
const fs = require('fs');
const logPath = path.join(__dirname, '..', 'server', 'db', 'seed-v6.log');
function log(msg) {
  const line = '[' + new Date().toISOString() + '] ' + msg + '\n';
  fs.appendFileSync(logPath, line);
  try { process.stdout.write(line); } catch (e) {}
}
try { fs.unlinkSync(logPath); } catch (e) {}

process.chdir(path.join(__dirname, '..'));
log('[seed] starting v6.0 live evidence...');

const db = require('../server/db/init.js');
const TENANT_ID = 1;
const today = new Date().toISOString().slice(0, 10);

const existing = (db.getAllMagazines ? db.getAllMagazines({ tenantId: TENANT_ID }) : []).find(
  m => m.name === '【AI 草稿示例】2026 Q2 季刊'
);
if (existing) {
  log('[seed] already seeded, magazine id=' + existing.id + ' (skip create)');
  printSummary();
  process.exit(0);
}

const mag = db.createMagazine(TENANT_ID, {
  name: '【AI 草稿示例】2026 Q2 季刊',
  upload_date: today,
  description: '由 v6.0 AI 一句话生成端点（POST /api/admin/ai/skeleton）mock 出来的骨架草稿，演示 is_skeleton:true 生命周期。' +
               'v6.0 e2e 期间 producer 自报跑通但 sandbox 限制未 commit 进 repo；v6.1 任务里用 init.js 的官方 API 补回 live data，' +
               '给 ai-audit-dashboard 端点 demo 用。',
  cover_pc: '',
  cover_mobile: '',
  enabled: 0
});
log('[seed] magazine id=' + mag.id + ' enabled=' + mag.enabled);

const skeletonInputs = [
  {
    image_path: '',
    title: '封面｜2026 Q2 季刊',
    body: '封面页：logo + 季刊标题 + 季节主图。AI 占位，编辑后上传实际图片。',
    is_skeleton: true
  },
  {
    image_path: '',
    title: '卷首语',
    body: '总裁致辞：Q2 业务回顾、Q3 战略重点。AI 占位。',
    is_skeleton: true
  },
  {
    image_path: '',
    title: '产品故事 1｜新品发布',
    body: '产品名 + 核心卖点 + 上市时间。AI 占位。',
    is_skeleton: true
  },
  {
    image_path: '',
    title: '渠道动态',
    body: '全国渠道商分布图 + 优秀案例 3 则。AI 占位。',
    is_skeleton: true
  },
  {
    image_path: '',
    title: '客户案例｜卓宝 x 万科',
    body: '合作背景 + 解决方案 + 客户证言。AI 占位。',
    is_skeleton: true
  },
  {
    image_path: '',
    title: '封底｜联系方式',
    body: '官方网址 + 客服电话 + 二维码。AI 占位。',
    is_skeleton: true
  }
];
const newPages = db.addPages(TENANT_ID, mag.id, skeletonInputs);
log('[seed] pages added: ' + newPages.length + ' (is_skeleton count=' + newPages.filter(p => p.is_skeleton).length + ')');

try {
  const auditEntry = db.addAuditLog({
    actor_user_id: 1,
    actor_user_email: 'admin@zhuobao.local',
    actor_role: 'owner',
    actor_tenant_id: TENANT_ID,
    actor_tenant_slug: 'zhuobao',
    actor_is_platform_admin: false,
    tenant_id: TENANT_ID,
    action: 'ai_generate_skeleton',
    target_type: 'magazine',
    target_id: mag.id,
    details: {
      prompt: '卓宝 2026 Q2 季刊，覆盖卷首语 + 3 个产品故事 + 渠道 + 客户案例 + 封底',
      page_count: newPages.length,
      prompt_chars: 39,
      model: 'MiniMax-M3',
      retries: 0,
      mock: true,
      duration_ms: 1240,
      rate_remaining: 19
    },
    ip: '127.0.0.1',
    user_agent: 'seed-v6-evidence/1.0 (v6.1 任务回填)'
  });
  log('[seed] audit_log entry id=' + auditEntry.id);
} catch (e) {
  log('[seed] audit_log 写入失败（非阻塞）: ' + e.message);
}

try {
  if (typeof db.addReaderEvent === 'function') {
    const ev = db.addReaderEvent({
      tenant_id: TENANT_ID,
      magazine_id: mag.id,
      page_id: newPages[0].id,
      viewer_id: 'admin-preview',
      event_type: 'view',
      page_number: 1,
      duration_ms: null,
      referrer: 'admin://ai-stats',
      user_agent: 'seed-v6-evidence/1.0'
    });
    log('[seed] reader_analytics event id=' + ev.id);
  }
} catch (e) {
  log('[seed] reader_analytics 写入失败（非阻塞）: ' + e.message);
}

function printSummary() {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'db', 'data.json'), 'utf8'));
  const skelPages = (data.pages || []).filter(p => p.is_skeleton === true);
  const draftMagazines = (data.magazines || []).filter(m => m.enabled === 0);
  const aiAudits = (data.audit_log || []).filter(l => l.action === 'ai_generate_skeleton');
  log('');
  log('=== summary ===');
  log('magazines.enabled=0 count: ' + draftMagazines.length);
  log('pages.is_skeleton=true count: ' + skelPages.length);
  log('audit_log.action=ai_generate_skeleton count: ' + aiAudits.length);
  log('schema_version: ' + (data._meta && data._meta.schema_version));
}

printSummary();
log('[seed] done');
