// 鉴权辅助（admin 全局）—— session-based，靠 HttpOnly cookie mag_admin_sid
// 用法（每个 admin HTML 头部）：
//   <script src="/admin/js/auth.js"></script>
//   <script>MAG_AUTH.requireAuth();</script>
// 登录页不要 requireAuth（避免循环跳）。
(function (global) {
  'use strict';

  // 登录页路径（相对 admin/ 根）—— 401 跳转目标
  var LOGIN_URL = '/admin/login.html';

  var cachedTenant = null;  // getTenant() 缓存

  function redirectToLogin() {
    // 保留 referrer，登录成功后跳回去
    try {
      var ref = document.referrer;
      // 只记同源 referrer（避免被外站劫持跳回）
      if (ref && new URL(ref).origin === location.origin) {
        localStorage.setItem('mag_admin_redirect', ref);
      }
    } catch (e) { /* ignore */ }
    location.href = LOGIN_URL;
  }

  function getRedirectTarget() {
    try {
      var target = localStorage.getItem('mag_admin_redirect');
      localStorage.removeItem('mag_admin_redirect');
      // 只接受同源相对路径（/admin/...）
      if (target && target.indexOf('/admin/') === 0) return target;
    } catch (e) { /* ignore */ }
    return '/admin/';
  }

  var MAG_AUTH = {
    /**
     * 检查登录态：未登录跳 /admin/login.html，登录成功原地 resolve
     * @returns {Promise<object|null>} tenant 对象，未登录时为 null（但页面已跳转）
     */
    requireAuth: function () {
      return fetch('/api/auth/me', { credentials: 'same-origin' })
        .then(function (res) {
          if (res.status === 401) {
            redirectToLogin();
            return null;
          }
          if (!res.ok) {
            throw new Error('鉴权检查失败 (HTTP ' + res.status + ')');
          }
          return res.json();
        })
        .then(function (data) {
          if (data && data.tenant) cachedTenant = data.tenant;
          return cachedTenant;
        });
    },

    /**
     * 获取当前 tenant（命中缓存；首次会拉一次 /me）
     * @returns {Promise<object|null>}
     */
    getTenant: function () {
      if (cachedTenant) return Promise.resolve(cachedTenant);
      return fetch('/api/auth/me', { credentials: 'same-origin' })
        .then(function (res) {
          if (!res.ok) return null;
          return res.json();
        })
        .then(function (data) {
          cachedTenant = data && data.tenant ? data.tenant : null;
          return cachedTenant;
        });
    },

    /**
     * 退出登录：清服务端 session + cookie，跳登录页
     */
    logout: function () {
      fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' })
        .catch(function () { /* 即使后端失败也清前端缓存并跳 */ })
        .then(function () {
          cachedTenant = null;
          location.href = LOGIN_URL;
        });
    },

    /**
     * 给登录页用的：登录成功后跳回原页
     */
    getRedirectTarget: getRedirectTarget
  };

  global.MAG_AUTH = MAG_AUTH;
})(window);
