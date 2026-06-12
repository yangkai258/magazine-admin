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