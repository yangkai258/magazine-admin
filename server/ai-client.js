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

module.exports = {
  generateMagazineSkeleton,
  // 仅供单测 / 调试：
  _internal: { extractJson, validateSkeleton, buildSystemPrompt, buildUserPrompt, mockSkeleton }
};