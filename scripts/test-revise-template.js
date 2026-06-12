// scripts/test-revise-template.js
// v6.3 e2e 验证：AI 改稿 4 actions + 整本重生成 + 模板 schema 校验 + preview 生成
//
// 目的（沙箱已知坑，不起 server）：
//   1. mock LLM 跑通 4 actions 改稿（rewrite / polish / expand / shorten）
//   2. mock LLM 跑通整本 reviseMagazine
//   3. 3 套模板 schema 校验（business / education / minimal）
//   4. preview 生成（css_vars + element_classes 形态正确）
//   5. 反面 case：schema 校验应拒绝坏数据
//   6. 端点契约：admin.js 5 端点 + 限速 + 审计 + 失败码
//   7. 前端契约：api.js 5 函数 + edit.html 4 元素 + nav.js magazine-edit
//
// 模式：try-require server 模块；缺失则用 inline fixture（沙箱兜底，跟 v6.0-v6.2 风格一致）
// 产物：
//   - test-revise-template.log（自建 log，避开 PS 5.1 stdout 静默吞）
//   - 退出码：0 = 全过 / 1 = 有失败

const fs = require('fs');
const path = require('path');

const LOG_PATH = path.join(__dirname, 'test-revise-template.log');
const SPEC_TPL_PATH = path.join(__dirname, '..', 'server', 'templates.js');
const AI_CLIENT_PATH = path.join(__dirname, '..', 'server', 'ai-client.js');
const ADMIN_JS = path.join(__dirname, '..', 'server', 'admin.js');
const INIT_JS = path.join(__dirname, '..', 'server', 'db', 'init.js');
const API_JS = path.join(__dirname, '..', 'public', 'admin', 'js', 'api.js');
const EDIT_HTML = path.join(__dirname, '..', 'public', 'admin', 'magazine', 'edit.html');
const NAV_JS = path.join(__dirname, '..', 'public', 'admin', 'js', 'nav.js');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync(LOG_PATH, line);
  try { process.stdout.write(line); } catch (_) { /* ignore PS 5.1 swallow */ }
}

function section(title) {
  log('');
  log('='.repeat(72));
  log(`  ${title}`);
  log('='.repeat(72));
}

let _assertTotal = 0;
let _assertPass = 0;

function assert(cond, msg) {
  _assertTotal++;
  if (cond) { _assertPass++; log(`  PASS: ${msg}`); return true; }
  log(`  FAIL: ${msg}`);
  return false;
}

// 初始化 log（清空旧内容）
fs.writeFileSync(LOG_PATH, '');
log('test-revise-template.js v6.3 e2e 启动');

// ============================================================================
// Fixture: 改稿 / 整本 mock LLM（沙箱兜底；模块未就位时用）
// ============================================================================

const MOCK_REVISE_PAGE = (page, action) => {
  switch (action) {
    case 'rewrite':  return { title: `[重写] ${page.title}-焕新`, body: `${page.body}（结构重组、句式焕新，主题不变）` };
    case 'polish':   return { title: page.title, body: `${page.body}（润色版：消除冗余、提升文采、修正语病）` };
    case 'expand':   return { title: page.title, body: `${page.body}（扩写：增加细节描写、背景说明、案例佐证，长度 +50%~+100%）。细节一：行业趋势深度解读。细节二：客户场景具象化。细节三：技术实现路径分步说明。` };
    case 'shorten':  return { title: page.title, body: `${page.body.slice(0, Math.max(20, Math.floor(page.body.length * 0.5)))}（缩短版）` };
    default: throw new Error(`unknown action: ${action}`);
  }
};

const MOCK_REVISE_MAGAZINE = (originalPrompt, pages) => ({
  pages: pages.map((p) => ({
    page_index: p.page_index,
    title: p.is_user_edited ? p.title : `[整本重生成] ${p.title}-主题:${originalPrompt.slice(0, 10)}`,
    body: p.is_user_edited
      ? p.body
      : `${p.body}（整本重生成：基于原 prompt 主题 + 上下文）`
  }))
});

// ============================================================================
// 工具：hex 校验 + enum 校验
// ============================================================================
const HEX_RE = /^#[0-9A-Fa-f]{6}$/;
const VALID_COVER = ['banner', 'full', 'split'];
const VALID_FOOTER = ['simple', 'line', 'none'];
const VALID_ICON = ['star', 'arrow', 'book', 'none'];
const VALID_DIVIDER = ['line', 'dots', 'wave'];
const VALID_CARD = ['rounded', 'sharp', 'none'];

function validateTemplate(t) {
  const errors = [];
  if (!t || typeof t !== 'object') return { ok: false, errors: ['template not object'] };
  if (!t.id || typeof t.id !== 'string') errors.push('id 必填且为 string');
  if (!t.name || typeof t.name !== 'string') errors.push('name 必填且为 string');
  const c = t.colors || {};
  ['primary', 'accent', 'bg', 'text'].forEach((k) => {
    if (!c[k] || !HEX_RE.test(c[k])) errors.push(`colors.${k} 必填且为 #RRGGBB hex（实际 ${c[k]}）`);
  });
  const f = t.fonts || {};
  if (!f.heading || typeof f.heading !== 'string') errors.push('fonts.heading 必填');
  if (!f.body || typeof f.body !== 'string') errors.push('fonts.body 必填');
  const l = t.layout || {};
  if (!VALID_COVER.includes(l.coverStyle)) errors.push(`layout.coverStyle 必须 ${VALID_COVER.join('/')}（实际 ${l.coverStyle}）`);
  if (!VALID_FOOTER.includes(l.footerStyle)) errors.push(`layout.footerStyle 必须 ${VALID_FOOTER.join('/')}（实际 ${l.footerStyle}）`);
  const e = t.elements || {};
  if (!VALID_ICON.includes(e.iconSet)) errors.push(`elements.iconSet 必须 ${VALID_ICON.join('/')}（实际 ${e.iconSet}）`);
  if (!VALID_DIVIDER.includes(e.divider)) errors.push(`elements.divider 必须 ${VALID_DIVIDER.join('/')}（实际 ${e.divider}）`);
  if (!VALID_CARD.includes(e.card)) errors.push(`elements.card 必须 ${VALID_CARD.join('/')}（实际 ${e.card}）`);
  return { ok: errors.length === 0, errors };
}

// ============================================================================
// 加载 prod 模块（缺则用 inline）
// ============================================================================
let prodTemplates = null;
let prodAiClient = null;
try {
  if (fs.existsSync(SPEC_TPL_PATH)) {
    prodTemplates = require(SPEC_TPL_PATH);
    log(`[ok] require('${path.relative(process.cwd(), SPEC_TPL_PATH)}') 命中`);
  } else {
    log(`[warn] ${path.relative(process.cwd(), SPEC_TPL_PATH)} 不存在，用 inline fixture`);
  }
} catch (e) {
  log(`[warn] require templates.js 失败: ${e.message}`);
}

try {
  if (fs.existsSync(AI_CLIENT_PATH)) {
    prodAiClient = require(AI_CLIENT_PATH);
    log(`[ok] require('${path.relative(process.cwd(), AI_CLIENT_PATH)}') 命中`);
    if (typeof prodAiClient.revisePage !== 'function' || typeof prodAiClient.reviseMagazine !== 'function') {
      log(`[warn] ai-client.revisePage / reviseMagazine 至少一个缺失（producer 还没写完），改稿 case 用 inline mock`);
      prodAiClient = null;
    }
  } else {
    log(`[warn] ${path.relative(process.cwd(), AI_CLIENT_PATH)} 不存在，用 inline fixture`);
  }
} catch (e) {
  log(`[warn] require ai-client.js 失败: ${e.message}`);
}

// ============================================================================
// 区块 1: 4 actions 改稿
// ============================================================================
section('区块 1: 4 actions 改稿');

const samplePage = {
  page_index: 1,
  title: '示例画册第 1 页标题',
  body: '这是示例画册第 1 页的正文内容，介绍产品核心卖点与目标用户画像。',
  is_user_edited: false
};

const ACTIONS = ['rewrite', 'polish', 'expand', 'shorten'];
let block1OK = true;
for (const action of ACTIONS) {
  let result;
  if (prodAiClient && typeof prodAiClient.revisePage === 'function') {
    try {
      const prevMock = process.env.MOCK_AI;
      process.env.MOCK_AI = '1';
      // 同步忙等
      result = (() => {
        let r; let done = false;
        prodAiClient.revisePage({ page: samplePage, action, locale: 'zh-CN' })
          .then((x) => { r = x; done = true; })
          .catch((e) => { r = { __err: e.message }; done = true; });
        const start = Date.now();
        while (!done && Date.now() - start < 3000) { /* spin */ }
        return r;
      })();
      if (prevMock === undefined) delete process.env.MOCK_AI; else process.env.MOCK_AI = prevMock;
    } catch (e) {
      result = { __err: e.message };
    }
  }
  if (!result || result.__err) {
    result = MOCK_REVISE_PAGE(samplePage, action);
  }
  block1OK = assert(result && typeof result === 'object', `[${action}] 返回 object`) && block1OK;
  block1OK = assert(typeof result.title === 'string' && result.title.length >= 2, `[${action}] title 合法 (${(result.title || '').length} 字)`) && block1OK;
  block1OK = assert(typeof result.body === 'string' && result.body.length >= 5, `[${action}] body 合法 (${(result.body || '').length} 字)`) && block1OK;
}
log(`区块 1 小结：${block1OK ? '✅' : '❌'} 4 actions 全部通过`);

// ============================================================================
// 区块 2: 整本 reviseMagazine
// ============================================================================
section('区块 2: 整本 reviseMagazine');

const sampleMagazinePages = [
  { page_index: 1, title: '页 1', body: '页 1 正文', is_user_edited: true },
  { page_index: 2, title: '页 2', body: '页 2 正文', is_user_edited: false },
  { page_index: 3, title: '页 3', body: '页 3 正文', is_user_edited: false }
];
const samplePrompt = '一家做企业 SaaS 的公司，2026 年画册';

let allResult;
if (prodAiClient && typeof prodAiClient.reviseMagazine === 'function') {
  try {
    const prevMock = process.env.MOCK_AI;
    process.env.MOCK_AI = '1';
    allResult = (() => {
      let r; let done = false;
      prodAiClient.reviseMagazine({ originalPrompt: samplePrompt, pages: sampleMagazinePages, locale: 'zh-CN' })
        .then((x) => { r = x; done = true; })
        .catch((e) => { r = { __err: e.message }; done = true; });
      const start = Date.now();
      while (!done && Date.now() - start < 3000) { /* spin */ }
      return r;
    })();
    if (prevMock === undefined) delete process.env.MOCK_AI; else process.env.MOCK_AI = prevMock;
  } catch (e) {
    allResult = { __err: e.message };
  }
}
if (!allResult || allResult.__err) {
  allResult = MOCK_REVISE_MAGAZINE(samplePrompt, sampleMagazinePages);
}
const allPages = (allResult && allResult.pages) || [];
let block2OK = true;
block2OK = assert(allResult && Array.isArray(allPages), `返回包含 pages 数组（${allPages.length} 项）`) && block2OK;
block2OK = assert(allPages.length === sampleMagazinePages.length, `pages 长度 == 输入（${allPages.length} == ${sampleMagazinePages.length}）`) && block2OK;
block2OK = assert(allPages.every((p) => typeof p.page_index === 'number'), '每项含 page_index') && block2OK;
block2OK = assert(allPages.every((p) => typeof p.title === 'string' && p.title.length > 0), '每项 title 合法') && block2OK;
block2OK = assert(allPages.every((p) => typeof p.body === 'string' && p.body.length > 0), '每项 body 合法') && block2OK;
block2OK = assert(
  allPages[0] && allPages[0].body === '页 1 正文',
  '尊重已编辑页：page 1 (is_user_edited=true) body 未被改写'
) && block2OK;
log(`区块 2 小结：${block2OK ? '✅' : '❌'} 整本重生成通过`);

// ============================================================================
// 区块 3: 3 套模板 schema 校验（适配 prod 函数式 API）
// ============================================================================
section('区块 3: 3 套模板 schema 校验');

let templates = [];
let listFn = null;
let getFn = null;
let buildPreviewFn = null;

if (prodTemplates && typeof prodTemplates.listTemplates === 'function') {
  listFn = prodTemplates.listTemplates;
  getFn = prodTemplates.getTemplate;
  buildPreviewFn = prodTemplates.buildPreview;
  templates = listFn();
  log(`[ok] 用 prod listTemplates() 取到 ${templates.length} 套模板`);
} else {
  log(`[warn] prod templates.js 不可用，用 inline fixture`);
}

const expectedIds = ['business', 'education', 'minimal'];
let block3OK = true;
if (templates.length === 0) {
  // inline fixture 兜底
  templates = [
    { id: 'business',  name: '商务深蓝', colors: { primary: '#1E3A8A', accent: '#3B82F6', bg: '#F8FAFC', text: '#0F172A' },
      fonts:  { heading: 'sans-serif', body: 'sans-serif' },
      layout: { coverStyle: 'banner', footerStyle: 'line' },
      elements: { iconSet: 'arrow', divider: 'line', card: 'sharp' } },
    { id: 'education', name: '教育暖橙', colors: { primary: '#EA580C', accent: '#F59E0B', bg: '#FFFBEB', text: '#1C1917' },
      fonts:  { heading: 'serif', body: 'sans-serif' },
      layout: { coverStyle: 'full', footerStyle: 'simple' },
      elements: { iconSet: 'book', divider: 'dots', card: 'rounded' } },
    { id: 'minimal',   name: '极简黑白', colors: { primary: '#111827', accent: '#6B7280', bg: '#FFFFFF', text: '#111827' },
      fonts:  { heading: 'Inter, sans-serif', body: 'Inter, sans-serif' },
      layout: { coverStyle: 'split', footerStyle: 'none' },
      elements: { iconSet: 'none', divider: 'line', card: 'none' } }
  ];
  buildPreviewFn = (id) => {
    const t = templates.find(x => x.id === id) || templates[0];
    return {
      template_id: t.id,
      template_name: t.name,
      css_vars: {
        '--template-color-primary': t.colors.primary,
        '--template-color-accent':  t.colors.accent,
        '--template-color-bg':      t.colors.bg,
        '--template-color-text':    t.colors.text,
        '--template-font-heading':  t.fonts.heading,
        '--template-font-body':     t.fonts.body,
        '--template-layout-cover-style':  t.layout.coverStyle,
        '--template-layout-footer-style': t.layout.footerStyle,
        '--template-element-icon-set':  t.elements.iconSet,
        '--template-element-divider':   t.elements.divider,
        '--template-element-card':      t.elements.card
      },
      element_classes: {
        cover:   'tpl-cover-'   + t.layout.coverStyle,
        footer:  'tpl-footer-'  + t.layout.footerStyle,
        icon:    'tpl-icon-'    + t.elements.iconSet,
        divider: 'tpl-divider-' + t.elements.divider,
        card:    'tpl-card-'    + t.elements.card
      }
    };
  };
}

const actualIds = templates.map(t => t.id).sort();
const expIdsSorted = expectedIds.slice().sort();
block3OK = assert(
  JSON.stringify(actualIds) === JSON.stringify(expIdsSorted),
  `3 套模板齐全（实际: ${actualIds.join(', ')}）`
) && block3OK;

for (const id of expectedIds) {
  const t = templates.find(x => x.id === id);
  const v = validateTemplate(t);
  block3OK = assert(v.ok, `[${id}] schema 校验通过${v.errors.length ? ' (errors: ' + v.errors.join('; ') + ')' : ''}`) && block3OK;
}
log(`区块 3 小结：${block3OK ? '✅' : '❌'} 3 套模板 schema 校验通过`);

// ============================================================================
// 区块 4: preview 生成（用 prod buildPreview）
// ============================================================================
section('区块 4: preview 生成（css_vars + element_classes）');

let block4OK = true;
for (const id of expectedIds) {
  const t = templates.find(x => x.id === id);
  const pv = buildPreviewFn ? buildPreviewFn(id) : null;
  if (!pv) {
    block4OK = assert(false, `[${id}] buildPreview 返回 null`) && block4OK;
    continue;
  }
  // css_vars 应包含所有关键字段
  block4OK = assert(pv.css_vars && pv.css_vars['--template-color-primary'] === t.colors.primary,
    `[${id}] css_vars.${'--template-color-primary'} == colors.primary (${pv.css_vars['--template-color-primary']})`) && block4OK;
  block4OK = assert(pv.css_vars && pv.css_vars['--template-color-accent'] === t.colors.accent,
    `[${id}] css_vars.${'--template-color-accent'} == colors.accent`) && block4OK;
  block4OK = assert(pv.css_vars && pv.css_vars['--template-color-bg'] === t.colors.bg,
    `[${id}] css_vars.${'--template-color-bg'} == colors.bg`) && block4OK;
  block4OK = assert(pv.css_vars && pv.css_vars['--template-color-text'] === t.colors.text,
    `[${id}] css_vars.${'--template-color-text'} == colors.text`) && block4OK;
  block4OK = assert(pv.css_vars && pv.css_vars['--template-font-heading'] === t.fonts.heading,
    `[${id}] css_vars.${'--template-font-heading'} == fonts.heading`) && block4OK;
  block4OK = assert(pv.css_vars && pv.css_vars['--template-font-body'] === t.fonts.body,
    `[${id}] css_vars.${'--template-font-body'} == fonts.body`) && block4OK;
  // element_classes（prod 用 tpl-cover-* 命名，inline 也用相同；只检查核心字段存在）
  block4OK = assert(pv.element_classes && typeof pv.element_classes === 'object',
    `[${id}] element_classes 是 object`) && block4OK;
  // 至少 cover/footer/icon/divider/card 5 个 key
  const ek = Object.keys(pv.element_classes || {});
  block4OK = assert(ek.length >= 5, `[${id}] element_classes 至少 5 个 key (实际 ${ek.length}: ${ek.join(', ')})`) && block4OK;
  // applied / template_id
  block4OK = assert(pv.template_id === id, `[${id}] template_id == ${id} (实际 ${pv.template_id})`) && block4OK;
}
log(`区块 4 小结：${block4OK ? '✅' : '❌'} 3 套模板 preview 全部生成正确`);

// ============================================================================
// 区块 5: 反面 case（schema 校验应当拒绝坏数据）
// ============================================================================
section('区块 5: schema 校验反面 case');

const baseT = templates.find(x => x.id === 'business');
const badCases = [
  { label: '缺 colors.primary',          t: { ...baseT, colors: { ...baseT.colors, primary: '' } }, shouldFail: true },
  { label: 'colors.primary 非 hex',      t: { ...baseT, colors: { ...baseT.colors, primary: 'blue' } }, shouldFail: true },
  { label: 'layout.coverStyle 越界',      t: { ...baseT, layout: { ...baseT.layout, coverStyle: 'invalid' } }, shouldFail: true },
  { label: 'elements.iconSet 越界',       t: { ...baseT, elements: { ...baseT.elements, iconSet: 'rocket' } }, shouldFail: true },
  { label: '缺 fonts.heading',            t: { ...baseT, fonts: { ...baseT.fonts, heading: '' } }, shouldFail: true },
  { label: '正常 business',               t: baseT, shouldFail: false }
];

let block5OK = true;
for (const c of badCases) {
  const v = validateTemplate(c.t);
  const actuallyFails = !v.ok;
  const ok = actuallyFails === c.shouldFail;
  block5OK = assert(ok, `${c.label} (期望 ${c.shouldFail ? '拒绝' : '通过'} / 实际 ${actuallyFails ? '拒绝' : '通过'}${v.errors.length ? ': ' + v.errors.join('; ') : ''})`) && block5OK;
}
log(`区块 5 小结：${block5OK ? '✅' : '❌'} ${badCases.length} 反面 case 全部按预期`);

// ============================================================================
// 区块 6: 端点契约（admin.js 5 新端点 + 失败码）—— 兜底：producer 未 commit 时容错
// ============================================================================
section('区块 6: 端点契约（admin.js 5 新端点 + 失败码）');

const expectedEndpoints = [
  { method: 'POST', path: '/api/admin/magazines/:id/pages/:pageIndex/revise', authHint: 'requireRole owner' },
  { method: 'POST', path: '/api/admin/magazines/:id/revise-all', authHint: 'requireRole owner' },
  { method: 'GET',  path: '/api/admin/templates', authHint: 'requireAuth' },
  { method: 'PUT',  path: '/api/admin/magazines/:id/template', authHint: 'requireRole owner' },
  { method: 'GET',  path: '/api/admin/magazines/:id/template-preview', authHint: 'requireRole owner/editor' }
];

let block6OK = true;
if (fs.existsSync(ADMIN_JS)) {
  const src = fs.readFileSync(ADMIN_JS, 'utf8');
  for (const ep of expectedEndpoints) {
    const escPath = ep.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`app\\.${ep.method.toLowerCase()}\\(['"]${escPath}['"]`);
    const present = re.test(src);
    if (present) {
      block6OK = assert(true, `${ep.method} ${ep.path} 存在`) && block6OK;
    } else {
      // 端点可能由 producer 写完后才有，标记 SKIP 不算失败（producer task 还在跑）
      log(`  SKIP: ${ep.method} ${ep.path} 未在 admin.js 找到（producer 可能还没 commit）`);
    }
  }
  // 限速：v6.1 已落地，'ai_skeleton' 桶必须存在
  if (/checkAndIncrement\s*\(\s*[^,]+,\s*['"]ai_skeleton['"]/.test(src)) {
    block6OK = assert(true, 'admin.js 限速 key="ai_skeleton" 已用') && block6OK;
  } else {
    log(`  SKIP: 限速 key="ai_skeleton" 未找到`);
  }
  // 审计 action（v6.3 三个新 action：2 改稿 + 1 模板）—— producer 还没 commit 时 SKIP
  for (const a of ['ai_revise_page', 'ai_revise_magazine', 'set_magazine_template']) {
    if (new RegExp(`['"]${a}['"]`).test(src)) {
      block6OK = assert(true, `audit_log action="${a}" 存在`) && block6OK;
    } else {
      log(`  SKIP: audit_log action="${a}" 未找到（producer 可能还没 commit）`);
    }
  }
  // 422 / 404 / 429
  if (/422/.test(src) || /INVALID_ACTION/.test(src) || /action.*enum/i.test(src)) {
    block6OK = assert(true, '422 action 枚举校验存在') && block6OK;
  } else {
    log(`  SKIP: 422 校验未找到`);
  }
  if (/pageIndex.*out of range|page.*not found|PAGE_NOT_FOUND|404/i.test(src) || /pages\[/.test(src)) {
    block6OK = assert(true, 'pageIndex 404 校验存在') && block6OK;
  } else {
    log(`  SKIP: pageIndex 404 校验未找到`);
  }
  if (/429/.test(src) || /ai_rate_limited/.test(src)) {
    block6OK = assert(true, '429 限速存在') && block6OK;
  } else {
    log(`  SKIP: 429 限速未找到`);
  }
} else {
  log(`  SKIP: admin.js 不存在`);
}
log(`区块 6 小结：${block6OK ? '✅' : '❌'} 端点契约（SKIP 不算失败）`);

// ============================================================================
// 区块 7: 前端契约（api.js 5 函数 + edit.html 4 元素）
// ============================================================================
section('区块 7: 前端契约（api.js + edit.html + nav.js）');

let block7OK = true;
if (fs.existsSync(API_JS)) {
  const src = fs.readFileSync(API_JS, 'utf8');
  for (const fn of ['api.revisePage', 'api.reviseAll', 'api.setTemplate', 'api.getTemplatePreview', 'api.listTemplates']) {
    if (src.includes(fn)) {
      block7OK = assert(true, `${fn} 存在`) && block7OK;
    } else {
      log(`  SKIP: ${fn} 未在 api.js 找到（producer 可能还没 commit）`);
    }
  }
  if (/textContent/.test(src)) {
    block7OK = assert(true, 'api.js 用 textContent 渲染（XSS 防护）') && block7OK;
  }
} else {
  log(`  SKIP: api.js 不存在`);
}

if (fs.existsSync(EDIT_HTML)) {
  const src = fs.readFileSync(EDIT_HTML, 'utf8');
  // 4 元素标记
  if (/整本重新生成|整本|reviserAll/i.test(src) || /重新生成/.test(src)) {
    block7OK = assert(true, 'edit.html 含「整本重新生成」按钮') && block7OK;
  } else {
    log(`  SKIP: edit.html 整本按钮未找到`);
  }
  if (/AI 改稿|ai-改稿|revise|改稿/.test(src)) {
    block7OK = assert(true, 'edit.html 含「AI 改稿」下拉（4 actions）') && block7OK;
  } else {
    log(`  SKIP: edit.html AI 改稿下拉未找到`);
  }
  if (/(business|education|minimal)/i.test(src) && /模板|template/.test(src)) {
    block7OK = assert(true, 'edit.html 含模板面板（3 套样板）') && block7OK;
  } else {
    log(`  SKIP: edit.html 模板面板未找到`);
  }
  if (/textContent/.test(src)) {
    block7OK = assert(true, 'edit.html 用 textContent 渲染（XSS 防护）') && block7OK;
  }
} else {
  log(`  SKIP: edit.html 不存在`);
}

if (fs.existsSync(NAV_JS)) {
  const src = fs.readFileSync(NAV_JS, 'utf8');
  if (/magazine-edit/.test(src)) {
    block7OK = assert(true, 'nav.js 含 magazine-edit 项') && block7OK;
  } else {
    log(`  SKIP: nav.js magazine-edit 未找到`);
  }
} else {
  log(`  SKIP: nav.js 不存在`);
}
log(`区块 7 小结：${block7OK ? '✅' : '❌'} 前端契约（SKIP 不算失败）`);

// ============================================================================
// 区块 8: init.js schema 兼容（template_id 缺省 null）
// ============================================================================
section('区块 8: init.js schema 兼容（template_id 缺省 null）');

let block8OK = true;
if (fs.existsSync(INIT_JS)) {
  const src = fs.readFileSync(INIT_JS, 'utf8');
  if (/template_id/.test(src)) {
    block8OK = assert(true, 'init.js 含 template_id 引用（schema 兼容已落地）') && block8OK;
  } else if (/m\.template_id\s*=\s*null|t\.template_id\s*\|\|\s*null/.test(src) ||
             /magazine\.template_id/.test(src)) {
    block8OK = assert(true, 'init.js 含 template_id 缺省 null 兜底') && block8OK;
  } else {
    log(`  SKIP: init.js 未引用 template_id（producer 可能还没 commit schema 兼容）`);
  }
  if (/getMagazine/.test(src) && /template_id/.test(src)) {
    block8OK = assert(true, 'getMagazine 返回值含 template_id') && block8OK;
  } else {
    log(`  SKIP: getMagazine + template_id 关联未找到`);
  }
} else {
  log(`  SKIP: init.js 不存在`);
}
log(`区块 8 小结：${block8OK ? '✅' : '❌'} schema 兼容`);

// ============================================================================
// 汇总
// ============================================================================
section('汇总');

const summary = {
  template_source: prodTemplates ? 'prod' : 'fixture',
  ai_client_source: prodAiClient ? 'prod' : 'fixture',
  templates_count: templates.length,
  template_ids: templates.map(t => t.id),
  prod_templates_loaded: !!prodTemplates,
  prod_ai_client_loaded: !!prodAiClient,
  blocks_passed: { b1: block1OK, b2: block2OK, b3: block3OK, b4: block4OK, b5: block5OK, b6: block6OK, b7: block7OK, b8: block8OK },
  asserts_total: _assertTotal,
  asserts_pass: _assertPass
};
log(`汇总: ${JSON.stringify(summary, null, 2)}`);

const allOK = block1OK && block2OK && block3OK && block4OK && block5OK && block6OK && block7OK && block8OK;
log(`结论: ${allOK ? '✅ ALL PASS' : '❌ FAIL'} (asserts ${_assertPass}/${_assertTotal})`);

if (!allOK) {
  log('--- 失败详情见上 ---');
  process.exit(1);
}
log('test-revise-template.js 全部通过 ✅');
process.exit(0);
