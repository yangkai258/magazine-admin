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