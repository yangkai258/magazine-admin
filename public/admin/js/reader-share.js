// /admin/js/reader-share.js
// 抽自 branding.html 的「阅读端分享链接」卡 + 4 case 渲染 + 全部事件绑定 + 重试逻辑。
// 暴露 MAG_READER_SHARE.mount(targetEl, ctx)：挂到任意 <div id="...">，ctx 注入依赖。
//
// ctx 必填项：
//   api                : { get(url), post(url, body) } —— MAG_API
//   toast(msg, kind)   : 全局提示
//   getCurrentRole()   : () => 'owner' | 'editor' | 'viewer' 等
//   getCurrentUser()   : () => { is_platform_admin: bool } | null
//   getCurrentSlug()   : () => 'zhuobao' 等
// 可选：
//   reload()           : 重新拉（默认 mount 时立即拉一次）
//
// 依赖：window.MAG_CONFIG.MAG_PUBLIC_PORT（保留兼容；优先用 server 返回的 link，无 port 字段）
(function() {
  'use strict';

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function escapeAttr(s) { return escapeHtml(s); }
  function maskSecret(s) {
    if (!s) return '';
    if (s.length <= 8) return '••••';
    return s.slice(0, 4) + '••••' + s.slice(-4);
  }
  function formatTs(s) {
    if (!s) return '-';
    var d = new Date(s);
    if (isNaN(d.getTime())) return '-';
    var pad = function(n) { return n < 10 ? '0' + n : '' + n; };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function(resolve, reject) {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'absolute';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        ok ? resolve() : reject(new Error('execCommand failed'));
      } catch (e) { reject(e); }
    });
  }

  // ===== 状态（每个 mount 一个）=====
  function createState(ctx) {
    return {
      ctx: ctx,
      targetEl: null,
      // reader secret 数据
      readerSecret: null,
      readerSecretShown: false,
      readerSecretLoading: true,
      readerSecretError: null, // 'forbidden' | 'load' | null
      readerSecretCreatedAt: null,
      readerSecretUpdatedAt: null
    };
  }

  function renderHTML(s) {
    var role = s.ctx.getCurrentRole();
    var me = s.ctx.getCurrentUser();
    // case 1: 非 owner 一律显示「权限不足」
    if (s.readerSecretError === 'forbidden' || (role && role !== 'owner')) {
      return ''
        + '<div class="branding-card reader-share-card" id="readerShareCard">'
        +   '<div class="branding-card-title">🔗 阅读端分享链接</div>'
        +   '<div class="branding-card-hint">当前账号角色是 <code>' + escapeHtml(role || '?') + '</code>，无访问权限。</div>'
        +   '<div class="reader-share-noaccess" id="rsNoAccess">'
        +     '🔒 权限不足：仅 <strong>租户 owner</strong> 可查看和管理阅读端分享链接。'
        +   '</div>'
        + '</div>';
    }
    // case 2: 加载中
    if (s.readerSecretLoading && !s.readerSecret) {
      return ''
        + '<div class="branding-card reader-share-card" id="readerShareCard">'
        +   '<div class="branding-card-title">🔗 阅读端分享链接</div>'
        +   '<div class="reader-share-loading" id="rsLoading"><div class="spin"></div><div>正在加载分享链接...</div></div>'
        + '</div>';
    }
    // case 3: 加载失败
    if (s.readerSecretError === 'forbidden') {
      return ''
        + '<div class="branding-card reader-share-card" id="readerShareCard">'
        +   '<div class="branding-card-title">🔗 阅读端分享链接</div>'
        +   '<div class="reader-share-noaccess" id="rsNoAccess">'
        +     '🔒 无权访问：当前角色 <code>' + escapeHtml(role || '?') + '</code> 无 owner 权限。'
        +   '</div>'
        + '</div>';
    }
    if (s.readerSecretError === 'load') {
      return ''
        + '<div class="branding-card reader-share-card" id="readerShareCard">'
        +   '<div class="branding-card-title">🔗 阅读端分享链接</div>'
        +   '<div class="reader-share-noaccess" id="rsNoAccess">'
        +     '⚠ 加载失败，请刷新页面重试。'
        +   '</div>'
        +   '<div class="reader-share-actions" style="margin-top:12px">'
        +     '<button class="btn btn-secondary btn-sm" id="rsRetryBtn" type="button">🔄 重试</button>'
        +   '</div>'
        + '</div>';
    }
    // case 4: 正常
    var secret = s.readerSecret || '';
    var displaySecret = s.readerSecretShown ? secret : maskSecret(secret);
    var showBtnText = s.readerSecretShown ? '🙈 隐藏' : '👁 显示';
    var link = s.readerSecretLink || ''; // server 返回的完整链接（无 50100 端口）
    var created = formatTs(s.readerSecretCreatedAt);
    var updated = formatTs(s.readerSecretUpdatedAt);
    var showRegen = !(me && me.is_platform_admin);
    var readonlyBadge = (me && me.is_platform_admin) ? '<span class="readonly-badge" id="rsReadonlyBadge">只读</span>' : '';

    return ''
      + '<div class="branding-card reader-share-card" id="readerShareCard">'
      +   '<div class="branding-card-title">🔗 阅读端分享链接 ' + readonlyBadge + '</div>'
      +   '<div class="branding-card-hint">把下面的链接发给读者；读者打开后会自动从 URL 取 secret，后续请求都带 <code>X-Reader-Secret</code> header。<strong>重新生成后旧链接立即失效</strong>。</div>'
      +   '<div class="reader-share-row">'
      +     '<div class="reader-share-label">Secret</div>'
      +     '<div class="reader-share-value">'
      +       '<code class="reader-share-code" id="rsSecretDisplay">' + escapeHtml(displaySecret) + '</code>'
      +       '<button class="btn btn-secondary btn-sm" id="rsToggleSecretBtn" type="button">' + showBtnText + '</button>'
      +     '</div>'
      +   '</div>'
      +   '<div class="reader-share-row">'
      +     '<div class="reader-share-label">完整链接</div>'
      +     '<div class="reader-share-value">'
      +       '<input class="reader-share-link-input" id="rsLinkInput" type="text" readonly value="' + escapeAttr(link) + '" onfocus="this.select()">'
      +       '<button class="btn btn-primary btn-sm" id="rsCopyBtn" type="button">📋 复制链接</button>'
      +     '</div>'
      +   '</div>'
      +   '<div class="reader-share-meta" id="rsMeta">'
      +     'slug: <code>' + escapeHtml(s.ctx.getCurrentSlug() || '') + '</code>'
      +     (created !== '-' ? '　·　创建：' + escapeHtml(created) : '')
      +     (updated !== '-' && updated !== created ? '　·　更新：' + escapeHtml(updated) : '')
      +   '</div>'
      + (showRegen
          ? '<div class="reader-share-warning"><span>⚠</span><span>重新生成会让所有正在使用旧链接的读者立即看到 <code>invalid_secret</code> 错误，请提前通知读者。</span></div>'
            + '<div class="reader-share-regen-row">'
            +   '<button class="btn btn-secondary btn-sm" id="rsRegenBtn" type="button">🔄 重新生成</button>'
            + '</div>'
          : '')
      + '</div>';
  }

  function bindEvents(s) {
    var toggleBtn = document.getElementById('rsToggleSecretBtn');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', function() {
        s.readerSecretShown = !s.readerSecretShown;
        var display = document.getElementById('rsSecretDisplay');
        if (display) display.textContent = s.readerSecretShown
          ? s.readerSecret
          : maskSecret(s.readerSecret);
        toggleBtn.textContent = s.readerSecretShown ? '🙈 隐藏' : '👁 显示';
      });
    }
    var copyBtn = document.getElementById('rsCopyBtn');
    if (copyBtn) {
      copyBtn.addEventListener('click', function() {
        var linkInput = document.getElementById('rsLinkInput');
        if (!linkInput) return;
        var link = linkInput.value;
        if (!link) { s.ctx.toast('链接为空', 'error'); return; }
        copyToClipboard(link)
          .then(function() { s.ctx.toast('✅ 链接已复制到剪贴板', 'success'); })
          .catch(function() { s.ctx.toast('复制失败，请手动选中复制', 'error'); });
      });
    }
    var regenBtn = document.getElementById('rsRegenBtn');
    if (regenBtn) {
      regenBtn.addEventListener('click', function() { onRegenerate(s); });
    }
    var retryBtn = document.getElementById('rsRetryBtn');
    if (retryBtn) {
      retryBtn.addEventListener('click', function() {
        s.readerSecretError = null;
        s.readerSecretLoading = true;
        render(s);
        loadReaderSecret(s);
      });
    }
  }

  function render(s) {
    if (!s.targetEl) return;
    s.targetEl.innerHTML = renderHTML(s);
    bindEvents(s);
  }

  function loadReaderSecret(s) {
    s.readerSecretLoading = true;
    s.readerSecretError = null;
    s.ctx.api.get('/admin/tenant/reader-secret')
      .then(function(d) {
        s.readerSecret = d.secret;
        s.readerSecretLink = d.link;
        s.readerSecretCreatedAt = d.created_at;
        s.readerSecretUpdatedAt = d.updated_at;
        s.readerSecretLoading = false;
        s.readerSecretError = null;
        render(s);
      })
      .catch(function(e) {
        s.readerSecretLoading = false;
        var msg = (e && e.message) || '';
        if (/403|ROLE_REQUIRED|owner/i.test(msg)) s.readerSecretError = 'forbidden';
        else s.readerSecretError = 'load';
        render(s);
      });
  }

  function onRegenerate(s) {
    if (!confirm('确定重新生成阅读端分享链接吗？\n\n旧链接会立即失效，正在用旧链接的读者会看到 invalid_secret 错误。')) return;
    s.ctx.api.post('/admin/tenant/reader-secret/regenerate', {})
      .then(function(d) {
        s.readerSecret = d.secret;
        s.readerSecretLink = d.link;
        s.readerSecretCreatedAt = d.created_at;
        s.readerSecretUpdatedAt = d.updated_at;
        s.readerSecretShown = false;
        s.ctx.toast('✅ 链接已重新生成', 'success');
        render(s);
      })
      .catch(function(e) {
        s.ctx.toast('重新生成失败：' + (e.message || '未知错误'), 'error');
      });
  }

  // ===== Public mount =====
  function mount(targetEl, ctx) {
    if (!targetEl) { console.error('[reader-share] targetEl required'); return; }
    if (!ctx || !ctx.api) { console.error('[reader-share] ctx.api required'); return; }
    var s = createState(ctx);
    s.targetEl = targetEl;
    render(s);
    loadReaderSecret(s);
    return {
      reload: function() { loadReaderSecret(s); },
      destroy: function() { s.targetEl.innerHTML = ''; }
    };
  }

  window.MAG_READER_SHARE = { mount: mount };
})();
