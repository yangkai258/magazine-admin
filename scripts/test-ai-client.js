// scripts/test-ai-client.js
//
// 用途：v6.3 AI 改稿客户端的离线 smoke test（不依赖 server 起来，不调真实 LLM）
//   1. 模块加载 + 接口签名
//   2. REVISE_ACTIONS 导出 + 4 actions 完整
//   3. system prompt 内容正确（"保持业务事实" / "尊重已编辑页" / 4 action 各自的措辞）
//   4. revisePage(mock) 4 actions 各跑通：返回 { title, body } + 长度合理 + _meta 完整
//   5. revisePage 错误：非法 action 抛错 / 空 page 抛错
//   6. validator 行为：title 太短 / body 太短 / 非对象 都被拦截
//   7. reviseMagazine(mock) 跑通：返回 pages.length = 输入，page_index 连续
//   8. reviseMagazine 错误：空 pages / page_index 错 / 超过 50
//   9. extractJson 行为（沿用 v6.0）
//
// 用法：
//   node scripts/test-ai-client.js
//
// 退出码：0 全过 / 1 有失败
// 沙箱期望：MOCK_AI=1（脚本内强制）-> 不打真实 LLM，全部 mock 路径
// 沙箱注意：PowerShell 5.1 下 node 子进程 stdout 经常被吞。如果想拿结果：
//   1) 在 Linux / Mac 直接 node 跑
//   2) 在 Windows 沙箱用 scripts/_run-test-ai-client.js 包一层（写日志到 test-ai-client.log）

'use strict';
process.env.MOCK_AI = '1';  // 强制 mock 模式（沙箱友好）

const path = require('path');
const ROOT = path.join(__dirname, '..');

function log(s) { process.stdout.write(s + '\n'); }
function assert(cond, msg) {
  if (!cond) { log('  FAIL: ' + msg); return false; }
  log('  OK:   ' + msg);
  return true;
}

async function main() {
  let pass = 0, fail = 0;
  const tally = (ok) => ok ? pass++ : fail++;

  log('=== test-ai-client.js (v6.3) ===');
  log('cwd: ' + ROOT);

  // ====== 1. 模块加载 + 接口签名 ======
  log('\n[1] load server/ai-client.js');
  const ai = require(path.join(ROOT, 'server', 'ai-client'));
  tally(assert(typeof ai.revisePage === 'function', 'revisePage is a function'));
  tally(assert(typeof ai.reviseMagazine === 'function', 'reviseMagazine is a function'));
  tally(assert(Array.isArray(ai.REVISE_ACTIONS), 'REVISE_ACTIONS is array'));
  tally(assert(typeof ai.REVISE_ACTION_PROMPTS === 'object', 'REVISE_ACTION_PROMPTS is object'));
  tally(assert(ai._internal && typeof ai._internal.buildReviseSystemPrompt === 'function', '_internal.buildReviseSystemPrompt'));
  tally(assert(ai._internal && typeof ai._internal.buildReviseUserPrompt === 'function', '_internal.buildReviseUserPrompt'));
  tally(assert(ai._internal && typeof ai._internal.buildReviseMagazineSystemPrompt === 'function', '_internal.buildReviseMagazineSystemPrompt'));
  tally(assert(ai._internal && typeof ai._internal.buildReviseMagazineUserPrompt === 'function', '_internal.buildReviseMagazineUserPrompt'));
  tally(assert(ai._internal && typeof ai._internal.validateRevisePage === 'function', '_internal.validateRevisePage'));
  tally(assert(ai._internal && typeof ai._internal.validateReviseMagazinePages === 'function', '_internal.validateReviseMagazinePages'));
  tally(assert(ai._internal && typeof ai._internal.mockRevisePage === 'function', '_internal.mockRevisePage'));
  tally(assert(ai._internal && typeof ai._internal.mockReviseMagazine === 'function', '_internal.mockReviseMagazine'));
  // 旧接口仍存在（v6.0/v6.2 兼容）
  tally(assert(typeof ai.generateMagazineSkeleton === 'function', 'generateMagazineSkeleton still exported (v6.0)'));
  tally(assert(typeof ai.analyzePdfPages === 'function', 'analyzePdfPages still exported (v6.2)'));

  // ====== 2. REVISE_ACTIONS 内容 ======
  log('\n[2] REVISE_ACTIONS content');
  const expectedActions = ['rewrite', 'polish', 'expand', 'shorten'];
  tally(assert(ai.REVISE_ACTIONS.length === 4, '4 actions'));
  tally(assert(expectedActions.every(a => ai.REVISE_ACTIONS.includes(a)), 'all of rewrite/polish/expand/shorten present'));
  for (const a of expectedActions) {
    const p = ai.REVISE_ACTION_PROMPTS[a];
    tally(assert(p && typeof p.label === 'string' && p.label.length > 0, `REVISE_ACTION_PROMPTS[${a}].label is non-empty`));
    tally(assert(p && typeof p.intent === 'string' && p.intent.length > 0, `REVISE_ACTION_PROMPTS[${a}].intent is non-empty`));
    tally(assert(p && typeof p.rule === 'string' && p.rule.length > 0, `REVISE_ACTION_PROMPTS[${a}].rule is non-empty`));
  }

  // ====== 3. system prompt 内容（强约束：保持事实 / 调整风格）======
  log('\n[3] buildReviseSystemPrompt content (per action)');
  for (const action of expectedActions) {
    const sp = ai._internal.buildReviseSystemPrompt({ locale: 'zh-CN', action });
    tally(assert(sp.includes('改稿动作：' + ai.REVISE_ACTION_PROMPTS[action].label), `[${action}] system prompt mentions action label`));
    tally(assert(sp.includes('保持原文业务事实'), `[${action}] system prompt includes "保持原文业务事实"`));
    tally(assert(sp.includes('仅调整风格或长度'), `[${action}] system prompt includes "仅调整风格或长度"`));
    tally(assert(sp.includes('不得编造'), `[${action}] system prompt includes "不得编造"`));
    tally(assert(sp.includes('"title"') && sp.includes('"body"'), `[${action}] system prompt has JSON schema for {title, body}`));
  }

  log('\n[4] buildReviseMagazineSystemPrompt content');
  const mp = ai._internal.buildReviseMagazineSystemPrompt({ locale: 'zh-CN' });
  tally(assert(mp.includes('整本必须围绕') || mp.includes('基于原 prompt 主题'), '整本 prompt includes "基于原 prompt 主题" 引导'));
  tally(assert(mp.includes('尊重已编辑页') || mp.includes('保留事实'), '整本 prompt includes "尊重已编辑页" 引导'));
  tally(assert(mp.includes('page_index'), '整本 prompt mentions page_index 约束'));
  tally(assert(mp.includes('不得编造'), '整本 prompt includes "不得编造"'));
  tally(assert(mp.includes('"pages"') && mp.includes('"title"') && mp.includes('"body"'), '整本 prompt has JSON schema for pages array'));

  // ====== 5. revisePage(mock) 4 actions 各跑通 ======
  log('\n[5] revisePage mock 4 actions');
  const samplePage = {
    title: '第二季度业务回顾',
    body: '本季度公司完成了 3 个核心目标：营收增长 18%、客户满意度提升至 92 分、新签合同 12 单。这些数据反映出团队执行力与产品市场匹配度的双重提升。'
  };
  for (const action of expectedActions) {
    let out;
    let okRun = true;
    try {
      out = await ai.revisePage({ page: samplePage, action, locale: 'zh-CN' });
    } catch (e) {
      log('  FAIL: revisePage(' + action + ') threw: ' + e.message);
      okRun = false;
    }
    tally(assert(okRun, 'revisePage(' + action + ') does not throw'));
    if (!okRun) continue;
    tally(assert(out && typeof out === 'object', '[' + action + '] returns object'));
    tally(assert(typeof out.title === 'string' && out.title.length > 0, '[' + action + '] title is non-empty string'));
    tally(assert(typeof out.body === 'string' && out.body.length >= 30, '[' + action + '] body length >= 30'));
    tally(assert(out.title.trim() === out.title, '[' + action + '] title is trimmed'));
    tally(assert(out.body.trim() === out.body, '[' + action + '] body is trimmed'));
    tally(assert(out._meta && out._meta.mock === true, '[' + action + '] _meta.mock=true'));
    tally(assert(out._meta && out._meta.action === action, '[' + action + '] _meta.action=' + action));
    tally(assert(out._meta && typeof out._meta.model === 'string' && out._meta.model.length > 0, '[' + action + '] _meta.model is string'));
    tally(assert(typeof out._meta.duration_ms === 'number', '[' + action + '] _meta.duration_ms is number'));
    tally(assert(typeof out._meta.retries === 'number', '[' + action + '] _meta.retries is number'));
    // 长度语义：expand 必更长 / shorten 必更短（mock 路径已强制）
    if (action === 'expand') {
      tally(assert(out.body.length > samplePage.body.length, '[expand] body longer than original (' + out.body.length + ' > ' + samplePage.body.length + ')'));
    }
    if (action === 'shorten') {
      tally(assert(out.body.length < samplePage.body.length, '[shorten] body shorter than original (' + out.body.length + ' < ' + samplePage.body.length + ')'));
    }
  }

  // ====== 6. revisePage 错误路径 ======
  log('\n[6] revisePage error cases');
  // 6.1 非法 action
  let threw = false;
  try { await ai.revisePage({ page: samplePage, action: 'translate' }); }
  catch (e) { threw = true; tally(assert(/action 必须是/.test(e.message), 'invalid action throws with "action 必须是..."')); }
  tally(assert(threw, 'invalid action throws'));

  // 6.2 空 page
  threw = false;
  try { await ai.revisePage({ page: null, action: 'polish' }); }
  catch (e) { threw = true; tally(assert(/page 必填/.test(e.message), 'null page throws with "page 必填..."')); }
  tally(assert(threw, 'null page throws'));

  // 6.3 title/body 都空
  threw = false;
  try { await ai.revisePage({ page: { title: '   ', body: '' }, action: 'polish' }); }
  catch (e) { threw = true; tally(assert(/不能同时为空/.test(e.message), 'empty page throws with "不能同时为空"')); }
  tally(assert(threw, 'empty page throws'));

  // 6.4 缺 action
  threw = false;
  try { await ai.revisePage({ page: samplePage }); } catch (e) { threw = true; }
  tally(assert(threw, 'missing action throws'));

  // ====== 7. validator 行为 ======
  log('\n[7] validateRevisePage');
  tally(assert(ai._internal.validateRevisePage(null) !== null, 'null -> invalid'));
  tally(assert(ai._internal.validateRevisePage({}) !== null, 'empty object -> invalid'));
  tally(assert(ai._internal.validateRevisePage({ title: '', body: 'a'.repeat(50) }) !== null, 'empty title -> invalid'));
  tally(assert(ai._internal.validateRevisePage({ title: 'OK', body: 'short' }) !== null, 'body too short -> invalid'));
  tally(assert(ai._internal.validateRevisePage({ title: 'a'.repeat(80), body: 'a'.repeat(50) }) !== null, 'title too long -> invalid'));
  tally(assert(ai._internal.validateRevisePage({ title: 'OK', body: 'a'.repeat(50) }) === null, 'valid object -> null'));

  // ====== 8. reviseMagazine(mock) 跑通 ======
  log('\n[8] reviseMagazine mock');
  const sampleMag = {
    originalPrompt: '聚焦 2026 年公司新业务线的季度回顾',
    pages: [
      { page_index: 1, title: '卷首语', body: '本期回顾第二季度公司业务发展。营收增长 18%，客户满意度提升至 92 分。'.padEnd(80, '。') },
      { page_index: 2, title: '产品线进展', body: '产品 A 完成 v2.0 发布，新增 3 个核心功能；产品 B 进入公测。'.padEnd(80, '。') },
      { page_index: 3, title: '客户案例', body: '客户 X 续约 3 年；客户 Y 增购 5 个模块。'.padEnd(80, '。') }
    ]
  };
  let magResult;
  let okRun = true;
  try { magResult = await ai.reviseMagazine(sampleMag); } catch (e) { log('  FAIL: reviseMagazine threw: ' + e.message); okRun = false; }
  tally(assert(okRun, 'reviseMagazine does not throw'));
  if (okRun) {
    tally(assert(Array.isArray(magResult.pages), 'returns { pages: [...] }'));
    tally(assert(magResult.pages.length === 3, 'pages.length matches input (3)'));
    tally(assert(magResult._meta && magResult._meta.mock === true, '_meta.mock=true'));
    tally(assert(magResult.pages[0].page_index === 1 && magResult.pages[1].page_index === 2 && magResult.pages[2].page_index === 3, 'page_index sequential 1..3'));
    for (let i = 0; i < magResult.pages.length; i++) {
      const p = magResult.pages[i];
      tally(assert(typeof p.title === 'string' && p.title.length > 0, 'page ' + (i+1) + ' title non-empty'));
      tally(assert(typeof p.body === 'string' && p.body.length >= 30, 'page ' + (i+1) + ' body length >= 30'));
    }
  }

  // ====== 9. reviseMagazine 错误路径 ======
  log('\n[9] reviseMagazine error cases');
  // 9.1 空 pages
  threw = false;
  try { await ai.reviseMagazine({ originalPrompt: 'x', pages: [] }); }
  catch (e) { threw = true; tally(assert(/pages 不能为空/.test(e.message), 'empty pages throws')); }
  tally(assert(threw, 'empty pages throws'));

  // 9.2 page_index 不连续
  threw = false;
  try {
    await ai.reviseMagazine({
      originalPrompt: 'x',
      pages: [
        { page_index: 1, title: 'a', body: 'a'.repeat(50) },
        { page_index: 3, title: 'b', body: 'b'.repeat(50) }   // 跳了 2
      ]
    });
  } catch (e) { threw = true; tally(assert(/page_index 必须等于/.test(e.message), 'non-sequential page_index throws')); }
  tally(assert(threw, 'non-sequential page_index throws'));

  // 9.3 pages 超过 50
  threw = false;
  const bigPages = [];
  for (let i = 1; i <= 51; i++) bigPages.push({ page_index: i, title: 't' + i, body: 'b'.repeat(50) });
  try { await ai.reviseMagazine({ originalPrompt: 'x', pages: bigPages }); }
  catch (e) { threw = true; tally(assert(/不能超过 50/.test(e.message), 'over 50 pages throws')); }
  tally(assert(threw, 'over 50 pages throws'));

  // 9.4 originalPrompt 过长
  threw = false;
  try {
    await ai.reviseMagazine({
      originalPrompt: 'a'.repeat(2001),
      pages: [{ page_index: 1, title: 't', body: 'b'.repeat(50) }]
    });
  } catch (e) { threw = true; tally(assert(/2000 字/.test(e.message), 'overlong originalPrompt throws')); }
  tally(assert(threw, 'overlong originalPrompt throws'));

  // 9.5 title / body 非字符串
  threw = false;
  try {
    await ai.reviseMagazine({
      originalPrompt: 'x',
      pages: [{ page_index: 1, title: 123, body: 'b'.repeat(50) }]
    });
  } catch (e) { threw = true; tally(assert(/title \/ body 必须是字符串/.test(e.message), 'non-string title throws')); }
  tally(assert(threw, 'non-string title throws'));

  // ====== 10. extractJson / validator 沿用 v6.0 行为 ======
  log('\n[10] extractJson (v6.0 compat) + validateReviseMagazinePages');
  tally(assert(ai._internal.extractJson('{"a":1}') && ai._internal.extractJson('{"a":1}').a === 1, 'extractJson direct JSON'));
  tally(assert(ai._internal.extractJson('```json\n{"a":2}\n```').a === 2, 'extractJson fenced JSON'));
  tally(assert(ai._internal.extractJson('not json at all') === null, 'extractJson returns null for garbage'));
  tally(assert(ai._internal.validateReviseMagazinePages({ pages: [{ page_index: 1, title: 't', body: 'b'.repeat(50) }] }, 1) === null, 'valid 1-page array passes'));
  tally(assert(ai._internal.validateReviseMagazinePages({ pages: [] }, 1) !== null, 'empty pages fails'));
  tally(assert(ai._internal.validateReviseMagazinePages({ pages: [{ page_index: 2, title: 't', body: 'b'.repeat(50) }] }, 1) !== null, 'wrong page_index fails'));

  log('\n=== summary: ' + pass + ' pass, ' + fail + ' fail ===');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => {
  log('\nFATAL: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
