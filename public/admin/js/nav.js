// MAG_NAV — 共享侧边栏 nav 渲染器
// 解决 5 路 UI 并行交付时各页面 nav 手写不一致的问题
//
// 用法（每个 admin HTML 页面）：
//   <aside class="sidebar">
//     <div class="sidebar-logo">📚 杂志管理平台</div>   <!-- logo 块各页自己定 -->
//     <nav class="sidebar-nav" id="sidebarNav"></nav>     <!-- 空容器，被本脚本填充 -->
//   </aside>
//   <script src="/admin/js/auth.js"></script>
//   <script src="/admin/js/nav.js"></script>
//   <script>MAG_NAV.render('dashboard');</script>         <!-- data-page 名 -->
//
// 依赖：MAG_AUTH（须先加载）
// 返回：Promise<{tenant, user}>，页面其余 JS 可 await 之后再执行
(function () {
  'use strict';

  // 单一权威 nav 列表 —— 任何页面都展示这 10 项，按角色隐藏
  // icon 字段是 Lucide 图标名（https://lucide.dev），前端在 nav-icon span 上用 data-lucide
  var ITEMS = [
    { key: 'dashboard',     icon: 'layout-dashboard', label: '总览',       href: '/admin/' },
    { key: 'magazine',      icon: 'book-open',        label: '杂志管理',   href: '/admin/magazine/list.html' },
    { key: 'cover',         icon: 'image',            label: '封面管理',   href: '/admin/cover/list.html' },
    { key: 'branding',      icon: 'palette',          label: '品牌定制',   href: '/admin/branding.html' },
    { key: 'analytics',     icon: 'bar-chart-3',      label: '阅读分析',   href: '/admin/analytics.html' },
    { key: 'billing',       icon: 'credit-card',      label: '订阅与计费', href: '/admin/billing.html',        role: 'owner' },
    { key: 'platform',      icon: 'building-2',       label: '平台管理',   href: '/admin/platform.html',       role: 'platform' },
    { key: 'audit',         icon: 'scroll-text',      label: '审计日志',   href: '/admin/audit.html',          role: 'platform' },
    { key: 'email-log',     icon: 'mail',             label: '邮件日志',   href: '/admin/email-log.html',      role: 'platform' },
    { key: 'tenant-users',  icon: 'users-round',      label: '用户管理',   href: '/admin/tenant-users.html',   role: 'owner' }
  ];

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function buildHtml(active, ctx) {
    var isPlatform = !!(ctx && ctx.tenant && ctx.tenant.is_platform_admin);
    var isOwner = !!(ctx && ctx.user && ctx.user.role === 'owner');
    var tenant = (ctx && ctx.tenant) || {};
    // 当前激活的菜单项：用品牌 logo 替换原 emoji，让「你在哪个租户」一眼可见
    var activeLogoUrl = tenant.logo_url || '';
    var activeLogoAlt = tenant.name || 'logo';

    return ITEMS.map(function (it) {
      // 角色过滤
      if (it.role === 'platform' && !isPlatform) return '';
      if (it.role === 'owner' && !isOwner) return '';

      var cls = 'nav-item';
      var isActive = (it.key === active);
      if (isActive) cls += ' active';
      // 激活项：如果租户有上传 logo，替换 nav-icon 为品牌 logo img
      // 否则用 Lucide 图标（data-lucide，nav.js 加载完后会替换为 <svg>）
      var iconHtml;
      if (isActive && activeLogoUrl) {
        iconHtml = '<img class="sidebar-logo-img nav-active-logo" src="' + escapeHtml(activeLogoUrl) + '" alt="' + escapeHtml(activeLogoAlt) + '">';
      } else {
        iconHtml = '<i class="nav-icon" data-lucide="' + escapeHtml(it.icon) + '"></i>';
      }
      return '<a href="' + escapeHtml(it.href) + '" class="' + cls + '" data-page="' + escapeHtml(it.key) + '">' +
             iconHtml + ' ' +
             escapeHtml(it.label) +
             '</a>';
    }).join('\n        ');
  }

  window.MAG_NAV = {
    /**
     * 渲染 nav 到 #sidebarNav
     * @param {string} active - 当前页面的 data-page 名（高亮）
     * @returns {Promise<{tenant:object,user:object}>}
     */
    render: function (active) {
      if (!window.MAG_AUTH) {
        console.error('[MAG_NAV] MAG_AUTH 未加载；请在 nav.js 之前先加载 /admin/js/auth.js');
        return Promise.resolve(null);
      }
      return MAG_AUTH.requireAuth().then(function (ctx) {
        var el = document.getElementById('sidebarNav');
        if (!el) {
          console.error('[MAG_NAV] 找不到 #sidebarNav 容器');
          return ctx;
        }
        el.innerHTML = buildHtml(active, ctx);
        // 顶栏 + 侧边栏 logo 由 topbar.js 提供；若已加载则一并渲染
        if (window.MAG_TOPBAR) {
          try { MAG_TOPBAR.render(ctx); } catch (e) { /* 容错 */ }
        }
        return ctx;
      });
    }
  };
})();
