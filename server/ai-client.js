// v6.0：MiniMax M3 客户端（OpenAI 兼容 chat completions 接口）
//
// 用法：
//   const skel = await aiClient.generateMagazineSkeleton({ title, prompt, pageCount, locale });
//
// Env vars：
//   MINIMAX_API_KEY    必填（缺了直接抛 "MINIMAX_API_KEY not configured"）
//   MINIMAX_BASE_URL   可选，默认 https://api.minimax.chat/v1
//   MINIMAX_MODEL      可选，默认 MiniMax-M3
//   MOCK_AI=1          沙箱 / 本地 e2e 走 mock（不打真实 LLM，返回固定 skeleton）
//
// 重试策略：5s / 15s / 30s 退避，最多 3 次（首调 + 2 次重试）。
// 失败原因分类：超时 / HTTP 4xx / HTTP 5xx / JSON parse 错，统一抛带 message 的 Error。
const http = require('http');
const https = require('https');
const { URL } = require('url');

const BASE_URL = (process.env.MINIMAX_BASE_URL || 'https://api.minimax.chat/v1').replace(/\/+$/, '');
const MODEL = process.env.MINIMAX_MODEL || 'MiniMax-M3';
const MAX_RETRIES = 3;            // 总尝试次数（含首次）
const BACKOFF_MS = [5000, 15000, 30000];  // 第 2/3 次调用前的等待

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function maskKey(k) {
  if (!k) return '(none)';
  if (k.length <= 8) return '****';
  return k.slice(0, 4) + '****' + k.slice(-4);
}

function buildSystemPrompt({ locale }) {
  const lang = locale === 'en-US' ? 'English' : '简体中文';
  return [
    '你是一位资深杂志主编，擅长根据一句话主题生成画册骨架（skeleton）。',
    `输出语言：${lang}。`,
    '',
    '【强约束】',
    '1) 必须只输出一个合法 JSON 对象，不要任何额外文字、注释、Markdown 代码块、思考过程。',
    '2) JSON 结构严格匹配：',
    '   {',
    '     "name": "<杂志标题，10-30 字>",',
    '     "description": "<一行描述，20-80 字>",',
    '     "pages": [',
    '       {"page_order": 1, "title": "<页标题，5-20 字>", "body": "<正稿，100-300 字，markdown 风格段落>"},',
    '       ...',
    '     ]',
    '   }',
    '3) page_order 从 1 起严格递增、连续整数、不重复。',
    '4) pages 数组长度必须等于调用方指定的 pageCount。',
    '5) 每个 body 必须是连贯段落，不是要点列表；可少量 markdown（** 加粗 / 换行 / 数字）。',
    '6) 不得编造公司名 / 真人 / 数据；遵循 prompt 里给出的事实。',
    '7) 不得返回任何系统说明、思考、警告、JSON 之外的字符。'
  ].join('\n');
}

function buildUserPrompt({ title, prompt, pageCount }) {
  return [
    title ? `期望标题（仅供参考，可调整）：${title}` : null,
    `主题描述：${prompt}`,
    `页数：${pageCount}`,
    '',
    '请严格按上面 JSON 结构输出。'
  ].filter(Boolean).join('\n');
}

// 在 LLM 返回文本里抠出第一个 JSON 对象（剥 ```json fences / 前缀杂文）
function extractJson(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  // 1) 直接 parse
  try { return JSON.parse(trimmed); } catch (_) {}
  // 2) 剥 ```json ... ``` / ``` ... ```
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try { return JSON.parse(fence[1].trim()); } catch (_) {}
  }
  // 3) 兜底：从第一个 { 起到最后一个 } 止
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    const slice = trimmed.slice(start, end + 1);
    try { return JSON.parse(slice); } catch (_) {}
  }
  return null;
}

function validateSkeleton(obj, pageCount) {
  if (!obj || typeof obj !== 'object') return 'LLM 未返回对象';
  if (typeof obj.name !== 'string' || !obj.name.trim()) return '缺少 name';
  if (typeof obj.description !== 'string' || !obj.description.trim()) return '缺少 description';
  if (!Array.isArray(obj.pages) || obj.pages.length !== pageCount) {
    return `pages 数组长度必须等于 ${pageCount}（实际 ${Array.isArray(obj.pages) ? obj.pages.length : '非数组'}）`;
  }
  for (let i = 0; i < obj.pages.length; i++) {
    const p = obj.pages[i];
    if (!p || typeof p !== 'object') return `pages[${i}] 不是对象`;
    if (p.page_order !== i + 1) return `pages[${i}].page_order 必须等于 ${i + 1}（实际 ${p.page_order}）`;
    if (typeof p.title !== 'string' || !p.title.trim()) return `pages[${i}].title 缺失`;
    if (typeof p.body !== 'string' || p.body.trim().length < 30) return `pages[${i}].body 太短或缺失`;
  }
  return null;
}

// 单次 HTTP 调用（不带重试）；超时 25s
function callOnce(apiKey, payload) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(BASE_URL + '/chat/completions'); }
    catch (e) { return reject(new Error('MINIMAX_BASE_URL 无效: ' + e.message)); }

    const body = JSON.stringify(payload);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request({
      method: 'POST',
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + (url.search || ''),
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': 'Bearer ' + apiKey
      },
      timeout: 25000
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const status = res.statusCode || 0;
        if (status < 200 || status >= 300) {
          return reject(new Error(`MiniMax HTTP ${status}: ${text.slice(0, 500)}`));
        }
        let json;
        try { json = JSON.parse(text); }
        catch (e) { return reject(new Error('MiniMax 返回非 JSON: ' + text.slice(0, 500))); }
        const choice = json.choices && json.choices[0];
        const content = choice && choice.message && choice.message.content;
        if (!content) return reject(new Error('MiniMax 返回缺少 choices[0].message.content: ' + text.slice(0, 500)));
        resolve(content);
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error('MiniMax 请求超时 (25s)'));
    });
    req.on('error', (e) => reject(new Error('MiniMax 网络错误: ' + e.message)));
    req.write(body);
    req.end();
  });
}

// ============ v6.3 AI 改稿（单页 + 整本）============
//
// 与 v6.0 generateMagazineSkeleton / v6.2 analyzePdfPages 共享同一 LLM 客户端 / 重试 / JSON 解析路径，
// 区别仅在 system prompt + 输入形态 + 输出 JSON 结构：
//
//   revisePage：
//     - 输入：{ page: { title, body, page_order? }, action: 'rewrite'|'polish'|'expand'|'shorten', locale }
//     - 输出：{ title, body }   （严守 JSON 对象）
//     - 设计原则：保持业务事实，仅调整风格/长度；不得编造公司/人/数据
//
//   reviseMagazine：
//     - 输入：{ originalPrompt, pages: [{page_index, title, body}, ...], locale }
//     - 输出：{ pages: [{page_index, title, body}, ...] }
//     - 设计原则：基于原 prompt 主题生成新内容；尊重已编辑页（如果某页用户已经改过、不要强行覆盖，提示让用户决定）
//
// action 语义：
//   rewrite  重写：换一种叙述角度（保留事实，重写表达）
//   polish   润色：保留原文 + 提升文字流畅度、修辞、节奏
//   expand   扩写：保留原文 + 增加细节/例子/解释
//   shorten  缩短：保留核心事实 + 削减冗余/修辞/次要细节

const REVISE_ACTIONS = ['rewrite', 'polish', 'expand', 'shorten'];

const REVISE_ACTION_PROMPTS = {
  rewrite: {
    label: '重写',
    intent: '从另一个叙述角度重新表达当前内容',
    rule: '换一种表达方式（句式、视角、结构）重新生成 title 与 body；不要简单复述原文。'
  },
  polish: {
    label: '润色',
    intent: '在保留原文信息的前提下提升文字质量',
    rule: '保留原文所有事实、立场、关键词不变；只调整文字流畅度、修辞、节奏、错别字；不要新增/删除事实。'
  },
  expand: {
    label: '扩写',
    intent: '在原内容基础上增加细节和解释',
    rule: '保留原文所有事实，作为新文的核心；增加背景说明、例子、场景细节、数字解释等；总字数比原 body 明显增加（≥ 1.4 倍）。'
  },
  shorten: {
    label: '缩短',
    intent: '保留核心事实 + 删除冗余',
    rule: '保留原文最重要的 1-2 个事实点；删除次要细节、修辞、重复表达；总字数比原 body 明显减少（≤ 0.6 倍）。'
  }
};

function buildReviseSystemPrompt({ locale, action }) {
  const lang = locale === 'en-US' ? 'English' : '简体中文';
  const act = REVISE_ACTION_PROMPTS[action];
  return [
    '你是一位资深杂志编辑，擅长对已有页面文本做局部改稿。',
    `输出语言：${lang}。`,
    `改稿动作：${act.label}（${act.intent}）。`,
    '',
    '【强约束】',
    '1) 必须只输出一个合法 JSON 对象，不要任何额外文字、注释、Markdown 代码块、思考过程。',
    '2) JSON 结构严格匹配：',
    '   {',
    '     "title": "<新页标题，5-20 字，与新 body 风格一致>",',
    '     "body":  "<新正稿，markdown 风格段落，50-400 字>"',
    '   }',
    '3) 改稿动作规则：' + act.rule,
    '4) 【保事实】保持原文业务事实不变：产品名 / 人名 / 数据 / 时间 / 地点 / 立场 一律不得改写、删除、编造。',
    '5) 【调风格 / 长度】除改稿动作明确要求外，仅调整风格或长度，不引入新观点。',
    '6) 标题若原文合适可微调；扩写/缩短时标题与新 body 长度匹配。',
    '7) 不得编造公司名 / 真人 / 数字 / 引用。',
    '8) 不得返回任何系统说明、思考、警告、JSON 之外的字符。'
  ].join('\n');
}

function buildReviseUserPrompt({ page, action }) {
  const title = (page && page.title) ? String(page.title) : '';
  const body = (page && page.body) ? String(page.body) : '';
  return [
    `改稿动作：${REVISE_ACTION_PROMPTS[action].label}`,
    '',
    '【原文 title】',
    title,
    '',
    '【原文 body】',
    body,
    '',
    '请严格按上面 JSON 结构输出 { title, body } 两个字段。'
  ].join('\n');
}

function validateRevisePage(obj) {
  if (!obj || typeof obj !== 'object') return 'LLM 未返回对象';
  if (typeof obj.title !== 'string' || !obj.title.trim()) return '缺少 title';
  if (typeof obj.body !== 'string' || obj.body.trim().length < 30) return 'body 太短或缺失（< 30 字）';
  if (obj.title.trim().length > 60) return 'title 超过 60 字';
  return null;
}

function buildReviseMagazineSystemPrompt({ locale }) {
  const lang = locale === 'en-US' ? 'English' : '简体中文';
  return [
    '你是一位资深杂志主编，擅长在保持整本画册主题一致的前提下重新生成内容。',
    `输出语言：${lang}。`,
    '',
    '【强约束】',
    '1) 必须只输出一个合法 JSON 对象，不要任何额外文字、注释、Markdown 代码块、思考过程。',
    '2) JSON 结构严格匹配：',
    '   {',
    '     "pages": [',
    '       {"page_index": 1, "title": "<页标题，5-20 字>", "body": "<正稿，80-300 字>"},',
    '       ...',
    '     ]',
    '   }',
    '3) page_index 从 1 起严格递增、连续整数、不重复，与输入页数完全一致。',
    '4) pages 数组长度必须等于输入的 page_count。',
    '5) 【基于原 prompt 主题】整本必须围绕"原 prompt 主题"展开；不得偏离主题。',
    '6) 【尊重已编辑页】如果某页用户已编辑过内容（出现在 pages 输入里），你必须以其原 title/body 为基础微调（保留事实），而不是无中生有地改写。如果某页 body 较长/含具体业务信息，倾向于 polish + 局部补充，不要大面积重写。',
    '7) 每个 body 必须是连贯段落（不是要点列表）；允许少量 markdown 强调（** 加粗）。',
    '8) 不得编造公司名 / 真人 / 数据；遵循原 prompt 主题 + 已编辑页事实。',
    '9) 不得返回任何系统说明、思考、警告、JSON 之外的字符。'
  ].join('\n');
}

function buildReviseMagazineUserPrompt({ originalPrompt, pages }) {
  const pageList = pages.map(p => `  - page_index=${p.page_index} title="${(p.title || '').slice(0, 40)}" body_len=${(p.body || '').length}`).join('\n');
  const sampleBlock = pages.map(p => `  [page_index=${p.page_index}]\n  title: ${p.title || ''}\n  body: ${(p.body || '').slice(0, 200)}${(p.body || '').length > 200 ? '...(截断)' : ''}`).join('\n\n');
  return [
    `原始 prompt 主题：${originalPrompt || '（无）'}`,
    `页数：${pages.length}`,
    '',
    '【原 pages 摘要（按页码顺序）】',
    pageList,
    '',
    '【原 pages 全文（用于尊重用户已编辑内容）】',
    sampleBlock,
    '',
    '请严格按上面 JSON 结构输出 pages 数组。'
  ].join('\n');
}

function validateReviseMagazinePages(obj, expectedCount) {
  if (!obj || typeof obj !== 'object') return 'LLM 未返回对象';
  if (!Array.isArray(obj.pages) || obj.pages.length !== expectedCount) {
    return `pages 数组长度必须等于 ${expectedCount}（实际 ${Array.isArray(obj.pages) ? obj.pages.length : '非数组'}）`;
  }
  for (let i = 0; i < obj.pages.length; i++) {
    const p = obj.pages[i];
    if (!p || typeof p !== 'object') return `pages[${i}] 不是对象`;
    if (p.page_index !== i + 1) return `pages[${i}].page_index 必须等于 ${i + 1}（实际 ${p.page_index}）`;
    if (typeof p.title !== 'string' || !p.title.trim()) return `pages[${i}].title 缺失`;
    if (typeof p.body !== 'string' || p.body.trim().length < 30) return `pages[${i}].body 太短或缺失`;
  }
  return null;
}

// Mock 模式：按 action 产出可预测的输出（不调真实 LLM）
function mockRevisePage({ page, action }) {
  const titleOrig = (page && page.title) ? String(page.title) : '';
  const bodyOrig = (page && page.body) ? String(page.body) : '';
  const prefix = '（MOCK）';
  switch (action) {
    case 'rewrite':
      return {
        title: prefix + '换一种视角的 ' + (titleOrig || '章节标题').slice(0, 16),
        body: (prefix + bodyOrig.split('。')[0] + '。从另一个视角看，这段内容可以这样展开。').padEnd(120, '。').slice(0, 220)
      };
    case 'polish':
      return {
        title: titleOrig || '润色后的标题',
        body: (prefix + bodyOrig.replace(/\s+/g, '')).padEnd(120, '。').slice(0, 220)
      };
    case 'expand':
      return {
        title: titleOrig || '扩写后的标题',
        body: (prefix + bodyOrig + '（扩写）在此基础上进一步展开背景与细节。' + bodyOrig.slice(0, 80)).padEnd(180, '。').slice(0, 360)
      };
    case 'shorten':
      return {
        title: titleOrig || '缩短后的标题',
        // 不 padEnd：shorten 必须明显短于原文（≤ 0.6 倍）
        // 优先取前半段；如果原文很短则只保留核心句
        body: (prefix + (bodyOrig.length > 0 ? bodyOrig.slice(0, Math.max(20, Math.floor(bodyOrig.length * 0.6))) : '（缩短后内容）')).slice(0, 140)
      };
    default:
      return { title: titleOrig, body: bodyOrig };
  }
}

function mockReviseMagazine({ pages, originalPrompt }) {
  const ph = (originalPrompt || '原主题').slice(0, 30);
  return {
    pages: pages.map(p => ({
      page_index: p.page_index,
      title: `（MOCK 整本重生成）${ph} · 第 ${p.page_index} 页`,
      body: `（MOCK 整本重生成 p${p.page_index}）围绕"${ph}"主题重新生成；尊重原页事实：${(p.body || '').slice(0, 60)}`.padEnd(120, '。').slice(0, 220)
    }))
  };
}

// ============ v6.2 PDF 多图分析 ============
//
// 与 v6.0 generateMagazineSkeleton 共享同一 LLM 客户端 / 重试 / JSON 解析路径，
// 区别仅在 system prompt + 输出 JSON 结构：
//   - 输入：pdfPages = [{ page_index, image_path, mime, imageBuffer? }]
//   - 输出：{ pages: [{ page_index, title, body }] }
//   - 不需要 name / description（PDF 主题已隐含在文件里）
//   - 长度必须等于 pdfPages.length
//
// 重要：MiniMax M3 是纯文本模型，**不能**直接把图片作为多模态输入（api 端点没有 vision）。
// 所以 pdfPages 在 prompt 里只作为「占位说明」（page 1 / page 2 / ... + 文件路径），
// 实际写作靠 LLM 的"画册编辑"通用能力 + 主题（由调用方传 `topic` 决定）。
// 如果未来切换到多模态 LLM，可在 user message 改成 image_url 列表，schema 不动。

function buildPdfSystemPrompt({ locale }) {
  const lang = locale === 'en-US' ? 'English' : '简体中文';
  return [
    '你是一位资深画册编辑，擅长根据 PDF 多页结构给每页写中文标题 + 简介。',
    `输出语言：${lang}。`,
    '',
    '【强约束】',
    '1) 必须只输出一个合法 JSON 对象，不要任何额外文字、注释、Markdown 代码块、思考过程。',
    '2) JSON 结构严格匹配：',
    '   {',
    '     "pages": [',
    '       {"page_index": 1, "title": "<页标题，5-20 字>", "body": "<正稿，60-200 字，markdown 风格段落>"},',
    '       {"page_index": 2, "title": "...", "body": "..."},',
    '       ...',
    '     ]',
    '   }',
    '3) page_index 从 1 起严格递增、连续整数、不重复，与输入页数完全一致。',
    '4) pages 数组长度必须等于输入的 page_count。',
    '5) 每个 body 必须是连贯段落（不是要点列表）；允许少量 markdown 强调（** 加粗）。',
    '6) 标题与正文要契合页码顺序的自然叙述逻辑（封面 / 目录 / 章节 / 结语）。',
    '7) 不得编造公司名 / 真人 / 数据；遵循 prompt 里给出的事实。',
    '8) 不得返回任何系统说明、思考、警告、JSON 之外的字符。'
  ].join('\n');
}

function buildPdfUserPrompt({ topic, pdfPages, totalPages }) {
  const pageList = pdfPages.map(p => `  - page_index=${p.page_index} path=${p.image_path || '(inline)'}`).join('\n');
  return [
    topic ? `主题背景：${topic}` : '主题背景：（无；请根据 PDF 页数结构自由发挥，假设是常规公司/产品画册）',
    `页数：${totalPages}`,
    '',
    '页面清单（按页码顺序）：',
    pageList,
    '',
    '请严格按上面 JSON 结构输出 pages 数组。'
  ].join('\n');
}

function validatePdfPagesResult(obj, expectedCount) {
  if (!obj || typeof obj !== 'object') return 'LLM 未返回对象';
  if (!Array.isArray(obj.pages) || obj.pages.length !== expectedCount) {
    return `pages 数组长度必须等于 ${expectedCount}（实际 ${Array.isArray(obj.pages) ? obj.pages.length : '非数组'}）`;
  }
  for (let i = 0; i < obj.pages.length; i++) {
    const p = obj.pages[i];
    if (!p || typeof p !== 'object') return `pages[${i}] 不是对象`;
    if (p.page_index !== i + 1) return `pages[${i}].page_index 必须等于 ${i + 1}（实际 ${p.page_index}）`;
    if (typeof p.title !== 'string' || !p.title.trim()) return `pages[${i}].title 缺失`;
    if (typeof p.body !== 'string' || p.body.trim().length < 30) return `pages[${i}].body 太短或缺失`;
  }
  return null;
}

function mockPdfPagesResult({ pdfPages }) {
  const pages = pdfPages.map(p => ({
    page_index: p.page_index,
    title: `第 ${p.page_index} 页 · 章节展开`,
    body: `（MOCK 第 ${p.page_index} 页）这是一段用于本地 e2e 的占位正文。LLM 未被调用——本次请求命中 MOCK_AI=1 分支，返回结构示例用于联调 PDF 解析 + 落库链路。真实接入后此段将由 MiniMax M3 根据 PDF 主题生成。`.padEnd(80, '。').slice(0, 180)
  }));
  return { pages };
}

// Mock 模式：返回固定 skeleton（不调真实 LLM）
function mockSkeleton({ title, prompt, pageCount }) {
  const baseName = title && title.trim() ? title.trim() : (prompt.split(/[，。,.!?！？\n]/)[0] || '新画册').slice(0, 24);
  const pages = [];
  for (let i = 1; i <= pageCount; i++) {
    pages.push({
      page_order: i,
      title: i === 1 ? '卷首语' : `第 ${i} 章 · 主题展开`,
      body: `（MOCK 第 ${i} 页）这是一段用于本地 e2e 的占位正文。LLM 未被调用——本次请求命中 MOCK_AI=1 分支，返回结构示例用于联调前端与落库链路。真实接入后此段将由 MiniMax M3 生成，主题来自用户 prompt：${prompt.slice(0, 60)}。`.padEnd(120, '。').slice(0, 220)
    });
  }
  return {
    name: baseName,
    description: '（MOCK）' + prompt.slice(0, 60),
    pages
  };
}

/**
 * 生成画册骨架
 * @param {Object} opts
 * @param {string} [opts.title]     期望标题（可选，最终以 LLM 返回的 name 为准）
 * @param {string} opts.prompt      用户主题描述（1-2000 字）
 * @param {number} [opts.pageCount]  页数 3..20（默认 6）
 * @param {string} [opts.locale]    'zh-CN' | 'en-US'（默认 'zh-CN'）
 * @returns {Promise<{name:string,description:string,pages:Array, _meta:{model:string,duration_ms:number,retries:number,mock:boolean}}>}
 */
async function generateMagazineSkeleton(opts = {}) {
  const title = (opts.title || '').toString().slice(0, 80).trim();
  const prompt = (opts.prompt || '').toString().trim();
  const pageCount = Math.max(3, Math.min(20, Number(opts.pageCount) || 6));
  const locale = opts.locale === 'en-US' ? 'en-US' : 'zh-CN';

  if (!prompt) throw new Error('prompt 不能为空');
  if (prompt.length > 2000) throw new Error('prompt 超过 2000 字');

  const startedAt = Date.now();
  const apiKey = process.env.MINIMAX_API_KEY;
  const mockMode = process.env.MOCK_AI === '1' || !apiKey;

  console.log(`[ai] generateMagazineSkeleton start model=${MODEL} pages=${pageCount} locale=${locale} mock=${mockMode} key=${maskKey(apiKey)}`);

  let retries = 0;
  let rawContent = null;
  let lastErr = null;

  if (mockMode) {
    // mock 模式：跳过网络，按"已成功"算 1 次尝试
    const skel = mockSkeleton({ title, prompt, pageCount });
    const duration_ms = Date.now() - startedAt;
    console.log(`[ai] generateMagazineSkeleton end mock duration_ms=${duration_ms} pages=${skel.pages.length}`);
    return { ...skel, _meta: { model: MODEL + ':mock', duration_ms, retries, mock: true } };
  }

  const payload = {
    model: MODEL,
    temperature: 0.6,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: buildSystemPrompt({ locale }) },
      { role: 'user', content: buildUserPrompt({ title, prompt, pageCount }) }
    ]
  };

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      rawContent = await callOnce(apiKey, payload);
      break;  // 成功
    } catch (e) {
      lastErr = e;
      const willRetry = attempt < MAX_RETRIES;
      console.warn(`[ai] attempt ${attempt}/${MAX_RETRIES} failed: ${e.message}${willRetry ? `, retry in ${BACKOFF_MS[attempt - 1]}ms` : ''}`);
      if (willRetry) {
        retries++;
        await sleep(BACKOFF_MS[attempt - 1]);
      }
    }
  }

  if (!rawContent) {
    const msg = `MiniMax 调用失败（已重试 ${retries} 次）: ${lastErr ? lastErr.message : 'unknown'}`;
    console.error('[ai] generateMagazineSkeleton fail', msg);
    throw new Error(msg);
  }

  const obj = extractJson(rawContent);
  if (!obj) {
    const msg = `MiniMax 返回内容无法解析为 JSON（已重试 ${retries} 次）`;
    console.error('[ai] json-parse-fail raw=', rawContent.slice(0, 300));
    throw new Error(msg);
  }
  const validationErr = validateSkeleton(obj, pageCount);
  if (validationErr) {
    const msg = `MiniMax 返回结构校验失败: ${validationErr}`;
    console.error('[ai] validation-fail obj=', JSON.stringify(obj).slice(0, 300));
    throw new Error(msg);
  }

  const duration_ms = Date.now() - startedAt;
  console.log(`[ai] generateMagazineSkeleton end duration_ms=${duration_ms} retries=${retries} pages=${obj.pages.length}`);

  return {
    name: obj.name.trim(),
    description: obj.description.trim(),
    pages: obj.pages.map(p => ({
      page_order: p.page_order,
      title: p.title.trim(),
      body: p.body.trim()
    })),
    _meta: { model: MODEL, duration_ms, retries, mock: false }
  };
}

/**
 * v6.2：分析 PDF 多页图，每页写 title + body
 * @param {Object} opts
 * @param {Array<{page_index:number, image_path?:string, mime?:string}>} opts.pdfPages
 *        每页元数据（page_index 必填且从 1 起连续）
 * @param {string} [opts.locale]  'zh-CN' | 'en-US'（默认 'zh-CN'）
 * @param {string} [opts.topic]   主题背景（让 LLM 围绕主题写；空 = LLM 自由发挥）
 * @returns {Promise<{pages:Array<{page_index:number,title:string,body:string}>, _meta:{model:string,duration_ms:number,retries:number,mock:boolean}}>}
 */
async function analyzePdfPages(opts = {}) {
  const pdfPages = Array.isArray(opts.pdfPages) ? opts.pdfPages : [];
  if (pdfPages.length === 0) throw new Error('pdfPages 不能为空');
  // 规范化 + 排序校验
  const sorted = pdfPages.slice().sort((a, b) => (a.page_index | 0) - (b.page_index | 0));
  for (let i = 0; i < sorted.length; i++) {
    if ((sorted[i].page_index | 0) !== i + 1) {
      throw new Error(`pdfPages[${i}].page_index 必须等于 ${i + 1}（实际 ${sorted[i].page_index}）`);
    }
  }
  const locale = opts.locale === 'en-US' ? 'en-US' : 'zh-CN';
  const topic = (opts.topic || '').toString().trim().slice(0, 500);

  const startedAt = Date.now();
  const apiKey = process.env.MINIMAX_API_KEY;
  const mockMode = process.env.MOCK_AI === '1' || !apiKey;

  console.log(`[ai] analyzePdfPages start model=${MODEL} pages=${sorted.length} locale=${locale} mock=${mockMode} key=${maskKey(apiKey)}`);

  let retries = 0;
  let rawContent = null;
  let lastErr = null;

  if (mockMode) {
    const obj = mockPdfPagesResult({ pdfPages: sorted });
    const duration_ms = Date.now() - startedAt;
    console.log(`[ai] analyzePdfPages end mock duration_ms=${duration_ms} pages=${obj.pages.length}`);
    return {
      pages: obj.pages.map(p => ({ page_index: p.page_index, title: p.title.trim(), body: p.body.trim() })),
      _meta: { model: MODEL + ':mock', duration_ms, retries, mock: true }
    };
  }

  const payload = {
    model: MODEL,
    temperature: 0.5,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: buildPdfSystemPrompt({ locale }) },
      { role: 'user', content: buildPdfUserPrompt({ topic, pdfPages: sorted, totalPages: sorted.length }) }
    ]
  };

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      rawContent = await callOnce(apiKey, payload);
      break;
    } catch (e) {
      lastErr = e;
      const willRetry = attempt < MAX_RETRIES;
      console.warn(`[ai] analyzePdfPages attempt ${attempt}/${MAX_RETRIES} failed: ${e.message}${willRetry ? `, retry in ${BACKOFF_MS[attempt - 1]}ms` : ''}`);
      if (willRetry) {
        retries++;
        await sleep(BACKOFF_MS[attempt - 1]);
      }
    }
  }

  if (!rawContent) {
    const msg = `MiniMax 调用失败（analyzePdfPages，已重试 ${retries} 次）: ${lastErr ? lastErr.message : 'unknown'}`;
    console.error('[ai] analyzePdfPages fail', msg);
    throw new Error(msg);
  }

  const obj = extractJson(rawContent);
  if (!obj) {
    const msg = `MiniMax 返回内容无法解析为 JSON（analyzePdfPages，已重试 ${retries} 次）`;
    console.error('[ai] analyzePdfPages json-parse-fail raw=', rawContent.slice(0, 300));
    throw new Error(msg);
  }
  const validationErr = validatePdfPagesResult(obj, sorted.length);
  if (validationErr) {
    const msg = `MiniMax 返回结构校验失败（analyzePdfPages）: ${validationErr}`;
    console.error('[ai] analyzePdfPages validation-fail obj=', JSON.stringify(obj).slice(0, 300));
    throw new Error(msg);
  }

  const duration_ms = Date.now() - startedAt;
  console.log(`[ai] analyzePdfPages end duration_ms=${duration_ms} retries=${retries} pages=${obj.pages.length}`);

  return {
    pages: obj.pages.map(p => ({
      page_index: p.page_index,
      title: p.title.trim(),
      body: p.body.trim()
    })),
    _meta: { model: MODEL, duration_ms, retries, mock: false }
  };
}

/**
 * v6.3：单页 AI 改稿（4 actions）
 * @param {Object} opts
 * @param {{title:string,body:string,page_order?:number}} opts.page  原页面文本
 * @param {'rewrite'|'polish'|'expand'|'shorten'} opts.action      改稿动作
 * @param {string} [opts.locale]                                   'zh-CN' | 'en-US'（默认 'zh-CN'）
 * @returns {Promise<{title:string,body:string,_meta:{model:string,duration_ms:number,retries:number,mock:boolean,action:string}}>}
 * @throws {Error} action 非法 / LLM 重试 3 次仍失败 / JSON 解析失败 / 校验失败
 */
async function revisePage(opts = {}) {
  const action = (opts.action || '').toString();
  if (!REVISE_ACTIONS.includes(action)) {
    throw new Error('action 必须是 ' + REVISE_ACTIONS.join('/') + '（实际 "' + action + '"）');
  }
  if (!opts.page || typeof opts.page !== 'object') {
    throw new Error('page 必填且为对象（含 title / body）');
  }
  const title = (opts.page.title || '').toString();
  const body = (opts.page.body || '').toString();
  if (!title.trim() && !body.trim()) {
    throw new Error('page.title 和 page.body 不能同时为空');
  }
  const locale = opts.locale === 'en-US' ? 'en-US' : 'zh-CN';

  const startedAt = Date.now();
  const apiKey = process.env.MINIMAX_API_KEY;
  const mockMode = process.env.MOCK_AI === '1' || !apiKey;

  console.log(`[ai] revisePage start model=${MODEL} action=${action} locale=${locale} mock=${mockMode} key=${maskKey(apiKey)}`);

  let retries = 0;
  let rawContent = null;
  let lastErr = null;

  if (mockMode) {
    const obj = mockRevisePage({ page: { title, body }, action });
    const duration_ms = Date.now() - startedAt;
    console.log(`[ai] revisePage end mock duration_ms=${duration_ms} action=${action}`);
    return {
      title: obj.title.trim(),
      body: obj.body.trim(),
      _meta: { model: MODEL + ':mock', duration_ms, retries, mock: true, action }
    };
  }

  const payload = {
    model: MODEL,
    temperature: 0.6,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: buildReviseSystemPrompt({ locale, action }) },
      { role: 'user', content: buildReviseUserPrompt({ page: { title, body }, action }) }
    ]
  };

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      rawContent = await callOnce(apiKey, payload);
      break;
    } catch (e) {
      lastErr = e;
      const willRetry = attempt < MAX_RETRIES;
      console.warn(`[ai] revisePage action=${action} attempt ${attempt}/${MAX_RETRIES} failed: ${e.message}${willRetry ? `, retry in ${BACKOFF_MS[attempt - 1]}ms` : ''}`);
      if (willRetry) {
        retries++;
        await sleep(BACKOFF_MS[attempt - 1]);
      }
    }
  }

  if (!rawContent) {
    const msg = `MiniMax 调用失败（revisePage action=${action}，已重试 ${retries} 次）: ${lastErr ? lastErr.message : 'unknown'}`;
    console.error('[ai] revisePage fail', msg);
    throw new Error(msg);
  }

  const obj = extractJson(rawContent);
  if (!obj) {
    const msg = `MiniMax 返回内容无法解析为 JSON（revisePage action=${action}，已重试 ${retries} 次）`;
    console.error('[ai] revisePage json-parse-fail raw=', rawContent.slice(0, 300));
    throw new Error(msg);
  }
  const validationErr = validateRevisePage(obj);
  if (validationErr) {
    const msg = `MiniMax 返回结构校验失败（revisePage action=${action}）: ${validationErr}`;
    console.error('[ai] revisePage validation-fail obj=', JSON.stringify(obj).slice(0, 300));
    throw new Error(msg);
  }

  const duration_ms = Date.now() - startedAt;
  console.log(`[ai] revisePage end duration_ms=${duration_ms} retries=${retries} action=${action} title_len=${obj.title.length} body_len=${obj.body.length}`);

  return {
    title: obj.title.trim(),
    body: obj.body.trim(),
    _meta: { model: MODEL, duration_ms, retries, mock: false, action }
  };
}

/**
 * v6.3：整本 AI 重新生成（基于原 prompt + 已编辑页 context）
 * @param {Object} opts
 * @param {string} opts.originalPrompt   原生成时的 prompt 主题（≤ 2000 字）
 * @param {Array<{page_index:number,title:string,body:string}>} opts.pages
 *        已编辑页列表（page_index 必填且从 1 起连续；用户已编辑过的事实要尊重）
 * @param {string} [opts.locale]         'zh-CN' | 'en-US'（默认 'zh-CN'）
 * @returns {Promise<{pages:Array<{page_index:number,title:string,body:string}>,_meta:{model:string,duration_ms:number,retries:number,mock:boolean}}>}
 * @throws {Error} pages 非法 / LLM 重试 3 次仍失败 / JSON 解析失败 / 校验失败
 */
async function reviseMagazine(opts = {}) {
  const originalPrompt = (opts.originalPrompt || '').toString().trim();
  const rawPages = Array.isArray(opts.pages) ? opts.pages : [];
  if (rawPages.length === 0) throw new Error('pages 不能为空');
  if (rawPages.length > 50) throw new Error('pages 数量不能超过 50（当前 ' + rawPages.length + '）');
  if (originalPrompt.length > 2000) throw new Error('originalPrompt 超过 2000 字');
  // 规范化 + 排序校验（与 v6.2 analyzePdfPages 一致）
  const sorted = rawPages.slice().sort((a, b) => (a.page_index | 0) - (b.page_index | 0));
  for (let i = 0; i < sorted.length; i++) {
    if ((sorted[i].page_index | 0) !== i + 1) {
      throw new Error(`pages[${i}].page_index 必须等于 ${i + 1}（实际 ${sorted[i].page_index}）`);
    }
    if (typeof sorted[i].title !== 'string' || typeof sorted[i].body !== 'string') {
      throw new Error(`pages[${i}].title / body 必须是字符串`);
    }
  }
  const locale = opts.locale === 'en-US' ? 'en-US' : 'zh-CN';

  const startedAt = Date.now();
  const apiKey = process.env.MINIMAX_API_KEY;
  const mockMode = process.env.MOCK_AI === '1' || !apiKey;

  console.log(`[ai] reviseMagazine start model=${MODEL} pages=${sorted.length} locale=${locale} mock=${mockMode} key=${maskKey(apiKey)}`);

  let retries = 0;
  let rawContent = null;
  let lastErr = null;

  if (mockMode) {
    const obj = mockReviseMagazine({ pages: sorted, originalPrompt });
    const duration_ms = Date.now() - startedAt;
    console.log(`[ai] reviseMagazine end mock duration_ms=${duration_ms} pages=${obj.pages.length}`);
    return {
      pages: obj.pages.map(p => ({
        page_index: p.page_index,
        title: p.title.trim(),
        body: p.body.trim()
      })),
      _meta: { model: MODEL + ':mock', duration_ms, retries, mock: true }
    };
  }

  const payload = {
    model: MODEL,
    temperature: 0.5,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: buildReviseMagazineSystemPrompt({ locale }) },
      { role: 'user', content: buildReviseMagazineUserPrompt({ originalPrompt, pages: sorted }) }
    ]
  };

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      rawContent = await callOnce(apiKey, payload);
      break;
    } catch (e) {
      lastErr = e;
      const willRetry = attempt < MAX_RETRIES;
      console.warn(`[ai] reviseMagazine attempt ${attempt}/${MAX_RETRIES} failed: ${e.message}${willRetry ? `, retry in ${BACKOFF_MS[attempt - 1]}ms` : ''}`);
      if (willRetry) {
        retries++;
        await sleep(BACKOFF_MS[attempt - 1]);
      }
    }
  }

  if (!rawContent) {
    const msg = `MiniMax 调用失败（reviseMagazine，已重试 ${retries} 次）: ${lastErr ? lastErr.message : 'unknown'}`;
    console.error('[ai] reviseMagazine fail', msg);
    throw new Error(msg);
  }

  const obj = extractJson(rawContent);
  if (!obj) {
    const msg = `MiniMax 返回内容无法解析为 JSON（reviseMagazine，已重试 ${retries} 次）`;
    console.error('[ai] reviseMagazine json-parse-fail raw=', rawContent.slice(0, 300));
    throw new Error(msg);
  }
  const validationErr = validateReviseMagazinePages(obj, sorted.length);
  if (validationErr) {
    const msg = `MiniMax 返回结构校验失败（reviseMagazine）: ${validationErr}`;
    console.error('[ai] reviseMagazine validation-fail obj=', JSON.stringify(obj).slice(0, 300));
    throw new Error(msg);
  }

  const duration_ms = Date.now() - startedAt;
  console.log(`[ai] reviseMagazine end duration_ms=${duration_ms} retries=${retries} pages=${obj.pages.length}`);

  return {
    pages: obj.pages.map(p => ({
      page_index: p.page_index,
      title: p.title.trim(),
      body: p.body.trim()
    })),
    _meta: { model: MODEL, duration_ms, retries, mock: false }
  };
}

module.exports = {
  generateMagazineSkeleton,
  analyzePdfPages,
  revisePage,
  reviseMagazine,
  // 仅供单测 / 调试：
  REVISE_ACTIONS,
  REVISE_ACTION_PROMPTS,
  _internal: {
    extractJson,
    validateSkeleton,
    validatePdfPagesResult,
    validateRevisePage,
    validateReviseMagazinePages,
    buildSystemPrompt,
    buildUserPrompt,
    buildPdfSystemPrompt,
    buildPdfUserPrompt,
    buildReviseSystemPrompt,
    buildReviseUserPrompt,
    buildReviseMagazineSystemPrompt,
    buildReviseMagazineUserPrompt,
    mockSkeleton,
    mockPdfPagesResult,
    mockRevisePage,
    mockReviseMagazine
  }
};