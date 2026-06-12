const API_BASE = '/api';  // 同源，admin 跑在 50030，浏览器自动拼成 http://localhost:50030/api

const api = {
  async get(path) {
    const res = await fetch(API_BASE + path);
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },
  async post(path, body, isFormData = false) {
    const options = { method: 'POST' };
    if (body) {
      if (isFormData) {
        options.body = body;
      } else {
        options.body = JSON.stringify(body);
        options.headers = { 'Content-Type': 'application/json' };
      }
    }
    const res = await fetch(API_BASE + path, options);
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },
  async put(path, body) {
    const res = await fetch(API_BASE + path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },
  async del(path) {
    const res = await fetch(API_BASE + path, { method: 'DELETE' });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }
};

function toast(msg, type = 'info') {
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.className = `toast ${type}`;
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

function formatDate(str) {
  if (!str) return '-';
  return str.slice(0, 10);
}

function coverImg(src) {
  if (!src) return 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="80" height="50" fill="%23ddd"><rect width="80" height="50"/></svg>';
  return src;  // 同源，相对路径如 /uploads/xxx.png 浏览器自动拼当前 origin
}

// v6.0 AI 一句话生成画册骨架（owner-only）—— 详细字段见 server/admin.js 的 POST /api/admin/ai/skeleton
api.aiSkeleton = ({ prompt, title, pageCount, locale }) =>
  api.post('/admin/ai/skeleton', { prompt, title, pageCount, locale });

// v6.2 PDF 智能生成（owner-only）—— 用 XHR 而非 fetch 是为了拿 upload.onprogress
// 后端：POST /api/admin/magazines/import-pdf （multipart/form-data, field=pdf）
// 成功：{ magazine, pages } ；失败：抛 Error，message 携带后端原始 err.message（401/403/400/500 各自区分）
api.aiPdfImport = (file, onProgress) => {
  return new Promise(function (resolve, reject) {
    var xhr = new XMLHttpRequest();
    var form = new FormData();
    form.append('pdf', file);
    xhr.upload.onprogress = function (e) {
      if (e.lengthComputable && typeof onProgress === 'function') {
        try { onProgress(Math.round((e.loaded / e.total) * 100)); } catch (_) { /* onProgress 抛错不能断上传 */ }
      }
    };
    xhr.onload = function () {
      var status = xhr.status;
      var raw = xhr.responseText;
      var parsed = null;
      try { parsed = raw ? JSON.parse(raw) : null; } catch (_) { parsed = null; }
      if (status >= 200 && status < 300) {
        resolve(parsed || {});
        return;
      }
      // 优先用后端 JSON 的 message / error 字段；兜底用 raw text
      var msg = (parsed && (parsed.message || parsed.error)) || raw || ('HTTP ' + status);
      // 401/403/400/500 全部走 reject，让调用方按 status 码分支处理
      var err = new Error(msg);
      err.status = status;
      err.body = parsed;
      reject(err);
    };
    xhr.onerror = function () {
      var err = new Error('网络错误，请检查连接后重试');
      err.status = 0;
      reject(err);
    };
    xhr.onabort = function () {
      var err = new Error('上传已取消');
      err.status = -1;
      reject(err);
    };
    xhr.open('POST', API_BASE + '/admin/magazines/import-pdf', true);
    // 不显式 setRequestHeader('Content-Type') —— 浏览器自动带 multipart boundary
    xhr.withCredentials = true;  // session cookie 带上
    xhr.send(form);
  });
};

// ============================================================================
// v6.3 AI 改稿（单页 + 整本）+ 模板预览 5 个 API
// ============================================================================
//
// 1) api.revisePage(magazineId, pageIndex, action)
//    - 后端：POST /api/admin/magazines/:id/pages/:pageIndex/revise
//    - body: { action: 'rewrite'|'polish'|'expand'|'shorten' }
//    - 用 XHR 而非 fetch 是为了和 aiPdfImport 风格统一 + 拿到精确 status 码做错误分支处理
//    - 成功：{ page: { title, body }, magazine: {...} }
//    - 限速：v6.1 沿用；429 走 err.status === 429 分支
//
// 2) api.reviseAll(magazineId, perPageActions)
//    - 后端：POST /api/admin/magazines/:id/revise-all
//    - body: { actions: ['polish','expand',...] }  // 长度 = pages.length；每个元素 = per-page action
//    - 成功：{ pages: [{title, body}, ...], magazine: {...} }
//
// 3) api.setTemplate(magazineId, templateId, overrides?)
//    - 后端：PUT /api/admin/magazines/:id/template
//    - body: { template_id: 'business'|'education'|'minimal'|null, overrides?: {...} }
//    - 成功：{ magazine: {...} }
//
// 4) api.getTemplatePreview(magazineId)
//    - 后端：GET /api/admin/magazines/:id/template-preview
//    - 成功：{ template_id, template_name, css_vars: {...}, element_classes: {...} }
//
// 5) api.listTemplates()
//    - 后端：GET /api/admin/templates
//    - 成功：[{ id, name, description, colors, fonts, layout, elements }, ...]
//
// 共同约定：
//   - 全部 owner-only（除 listTemplates 也是 admin 端读）；
//   - 错误统一抛 Error + err.status（401/403/404/422/429/500 分支见 edit.html）；
//   - 不写全局 state，调用方拿到响应后自行更新 UI。

api.revisePage = function (magazineId, pageIndex, action) {
  return new Promise(function (resolve, reject) {
    if (magazineId == null || pageIndex == null || !action) {
      var e = new Error('revisePage 必填 magazineId / pageIndex / action');
      e.status = -1;
      return reject(e);
    }
    var xhr = new XMLHttpRequest();
    xhr.onload = function () {
      var status = xhr.status;
      var raw = xhr.responseText;
      var parsed = null;
      try { parsed = raw ? JSON.parse(raw) : null; } catch (_) { parsed = null; }
      if (status >= 200 && status < 300) {
        resolve(parsed || {});
        return;
      }
      var msg = (parsed && (parsed.message || parsed.error)) || raw || ('HTTP ' + status);
      var err = new Error(msg);
      err.status = status;
      err.body = parsed;
      reject(err);
    };
    xhr.onerror = function () {
      var err = new Error('网络错误，请检查连接后重试');
      err.status = 0;
      reject(err);
    };
    xhr.onabort = function () {
      var err = new Error('请求已取消');
      err.status = -1;
      reject(err);
    };
    var url = API_BASE + '/admin/magazines/' + encodeURIComponent(magazineId) +
              '/pages/' + encodeURIComponent(pageIndex) + '/revise';
    xhr.open('POST', url, true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.withCredentials = true;
    xhr.send(JSON.stringify({ action: action }));
  });
};

// reviseAll：整本重生成（per-page action map）
// 后端：POST /api/admin/magazines/:id/revise-all body={ actions: ['polish','expand',...] }
api.reviseAll = function (magazineId, perPageActions) {
  return api.post('/admin/magazines/' + encodeURIComponent(magazineId) + '/revise-all', {
    actions: perPageActions
  });
};

// setTemplate：设置 / 清除 magazine 的 template_id
// 后端：PUT /api/admin/magazines/:id/template body={ template_id, overrides? }
// template_id === null 时为「恢复默认」（后端会写 null）
api.setTemplate = function (magazineId, templateId, overrides) {
  var payload = { template_id: templateId == null ? null : templateId };
  if (overrides && typeof overrides === 'object') payload.overrides = overrides;
  return api.put('/admin/magazines/' + encodeURIComponent(magazineId) + '/template', payload);
};

// getTemplatePreview：拿当前 magazine 的 css_vars + element_classes（用于实时预览注入）
// 后端：GET /api/admin/magazines/:id/template-preview
api.getTemplatePreview = function (magazineId) {
  return api.get('/admin/magazines/' + encodeURIComponent(magazineId) + '/template-preview');
};

// listTemplates：列 3 套内置样板
// 后端：GET /api/admin/templates
api.listTemplates = async function () {
  return api.get('/admin/templates');
};