/**
 * MAG_TRACK — Reader 端埋点客户端
 * 用于 splash / directory / viewer 三个阅读端向 /api/public/analytics/track 上报
 *
 * 用法：
 *   <script src="reader/track.js"></script>
 *   <script>
 *     window.MAG_TRACK.trackEvent({ tenant_slug: 'xxx', event_type: 'view', magazine_id: 1, page_number: 1 });
 *   </script>
 *
 * viewer_id 跨页面持久化（localStorage），用于跟读同一访客。
 * 上报用 navigator.sendBeacon 优先（离开页面/导航期间也能发），fetch keepalive 兜底。
 */
(function () {
  'use strict';

  function uuidv4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var y = (c === 'y') ? ((r & 0x3) | 0x8) : r;
      return y.toString(16);
    });
  }

  function getOrCreateViewerId() {
    try {
      var k = 'mag_reader_viewer_id';
      var v = localStorage.getItem(k);
      if (!v) {
        v = uuidv4();
        localStorage.setItem(k, v);
      }
      return v;
    } catch (e) {
      return 'anon-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
    }
  }

  var VIEWER_ID = getOrCreateViewerId();

  function trackEvent(payload) {
    if (!payload || typeof payload !== 'object') return;
    var body;
    try {
      body = JSON.stringify(Object.assign({ viewer_id: VIEWER_ID }, payload));
    } catch (e) {
      return;
    }
    var blob = new Blob([body], { type: 'application/json' });
    try {
      if (navigator.sendBeacon && navigator.sendBeacon('/api/public/analytics/track', blob)) return;
    } catch (e) { /* fallthrough */ }
    try {
      // keepalive fetch 兜底：通过 MAG_READER_AUTH.fetch 包装，
      // 自动注入 X-Reader-Secret header（如果当前已存到 localStorage），
      // 401 时清掉 secret + 派发 'reader:auth_failed' 事件
      var doFetch = (window.MAG_READER_AUTH && window.MAG_READER_AUTH.fetch) || fetch;
      doFetch('/api/public/analytics/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
        keepalive: true
      }).catch(function () { /* ignore */ });
    } catch (e) { /* ignore */ }
  }

  // 暴露给页面其他脚本
  window.MAG_TRACK = {
    trackEvent: trackEvent,
    viewerId: function () { return VIEWER_ID; }
  };
})();
