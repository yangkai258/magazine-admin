/**
 * MAG_READER_AUTH — 阅读端 secret 管理
 *
 * 用法：
 *   <script src="reader/secret.js"></script>
 *   <script>
 *     window.MAG_READER_AUTH.init();              // 页面启动时调用：从 URL ?s=xxx 读 → 存 localStorage
 *     window.MAG_READER_AUTH.getSecret();        // 返 string | null
 *     window.MAG_READER_AUTH.fetch(url, opts);   // 包装 fetch，自动加 X-Reader-Secret header + 401 拦截
 *     window.MAG_READER_AUTH.clear();            // 清掉 localStorage（401 时自动调）
 *   </script>
 *
 * 设计要点：
 *  1) init() 优先从 URL ?s= 读 → 写入 localStorage；如果 URL 没有，则读 localStorage
 *  2) 401 时清掉 localStorage + 派发 'reader:auth_failed' 事件，页面监听后展示提示
 *  3) fetch 包装：自动注入 X-Reader-Secret header，跨页跳转时由页面侧负责把 secret 拼到 URL（&s=xxx）
 *  4) 后端校验：header X-Reader-Secret 优先；query ?secret=xxx 兜底（未来扩展用）
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'mag_reader_secret';

  // 读 ?s= 参数；优先 trim 过滤空值
  function readSecretFromUrl() {
    try {
      var s = new URLSearchParams(location.search).get('s');
      if (s && String(s).trim()) return String(s).trim();
    } catch (e) { /* ignore */ }
    return null;
  }

  function readSecretFromStorage() {
    try { return localStorage.getItem(STORAGE_KEY); } catch (e) { return null; }
  }

  function writeSecretToStorage(secret) {
    try { localStorage.setItem(STORAGE_KEY, secret); } catch (e) { /* 隐私模式可能抛 */ }
  }

  function removeSecretFromStorage() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
  }

  function dispatchAuthFailed() {
    try {
      window.dispatchEvent(new CustomEvent('reader:auth_failed'));
    } catch (e) {
      // 老浏览器兜底
      try {
        var evt = document.createEvent('CustomEvent');
        evt.initCustomEvent('reader:auth_failed', false, false, null);
        window.dispatchEvent(evt);
      } catch (_) { /* ignore */ }
    }
  }

  window.MAG_READER_AUTH = {
    /**
     * 页面启动时调用一次：
     *   1) URL ?s= 优先 → 存到 localStorage
     *   2) 否则从 localStorage 读（用户刷新页面的场景）
     * 返回当前有效的 secret（string | null）
     */
    init: function () {
      var fromUrl = readSecretFromUrl();
      if (fromUrl) {
        writeSecretToStorage(fromUrl);
        return fromUrl;
      }
      return readSecretFromStorage();
    },

    /** 返当前 secret（可能为 null） */
    getSecret: function () {
      return readSecretFromStorage();
    },

    /** 清掉 localStorage（401 时内部自动调；外部一般不需要） */
    clear: function () {
      removeSecretFromStorage();
    },

    /**
     * 包装 fetch：自动注入 X-Reader-Secret header；401 拦截 + 派发事件
     * 用法同原生 fetch(url, options)，返 Promise<Response>
     */
    fetch: function (url, options) {
      options = options || {};
      // 浅克隆 headers 避免污染调用方的对象
      var headers = {};
      if (options.headers) {
        if (options.headers instanceof Headers) {
          options.headers.forEach(function (v, k) { headers[k] = v; });
        } else {
          for (var k in options.headers) {
            if (Object.prototype.hasOwnProperty.call(options.headers, k)) headers[k] = options.headers[k];
          }
        }
      }
      var secret = readSecretFromStorage();
      if (secret) headers['X-Reader-Secret'] = secret;
      // credentials 允许 same-origin 携带 cookie（虽然现在没用到，但保留扩展性）
      options.headers = headers;
      if (options.credentials == null) options.credentials = 'same-origin';

      return fetch(url, options).then(function (r) {
        if (r && r.status === 401) {
          // secret 失效：清掉 + 通知页面
          removeSecretFromStorage();
          dispatchAuthFailed();
        }
        return r;
      });
    }
  };
})();
