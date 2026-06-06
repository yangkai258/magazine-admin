// MAG_TOPBAR — 共享顶栏 + 侧边栏 logo 渲染器
// 解决 5 路 UI 并行交付时只有 index.html 有顶栏品牌 + 顶栏用户徽章，其他页都缺
//
// 用法（每个 admin HTML 页面）：
//   <script src="/admin/js/auth.js"></script>
//   <script src="/admin/js/nav.js"></script>
//   <script src="/admin/js/topbar.js"></script>
//   <script>
//     MAG_NAV.render('xxx').then(function (ctx) {
//       MAG_TOPBAR.render(ctx);
//     });
//   </script>
//
// 行为：
// - 侧边栏：若只有 .sidebar-logo 文本块（其他页），自动替换成富块（logo + 名字 + 副标）
// - 顶栏：在 .top-bar 内、退出登录按钮前注入「欢迎 user@x + [role]」+ 「租户徽章」
// - 已富的元素（index.html）只填充，不重建
//
// 依赖：MAG_AUTH（auth.js）
(function () {
  'use strict';

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // 侧边栏富 logo HTML（其他页只有文本 .sidebar-logo 时替换）
  // 注：只显示「首字 + 名字 + 副标」，不渲染上传图片（32x32 容易糊）
  function buildRichSidebarLogo(tenant) {
    var name = escapeHtml(tenant.name || '杂志管理平台');
    var slug = escapeHtml(tenant.slug || '');
    var isPlatform = !!tenant.is_platform_admin;
    var sub = isPlatform
      ? '👑 平台管理员 · SaaS · v4'
      : ('租户 · ' + slug);
    var initial = (name && name.length) ? name.charAt(0) : '📚';
    return (
      '<div class="sidebar-logo" id="sidebarLogo">' +
        '<div class="sidebar-logo-fallback" id="sidebarLogoFallback">' + escapeHtml(initial) + '</div>' +
        '<div style="min-width:0">' +
          '<div class="sidebar-logo-text" id="sidebarLogoText">' + name + '</div>' +
          '<div class="sidebar-logo-sub" id="sidebarLogoSub">' + escapeHtml(sub) + '</div>' +
        '</div>' +
      '</div>'
    );
  }

  // 顶栏用户信息 HTML（index.html 已有，其他页要注入）
  function buildTopbarUserInfo(user) {
    var email = escapeHtml(user && user.email || '');
    var role = (user && user.role) || 'viewer';
    var roleLabel = role === 'owner' ? 'OWNER' : (role === 'editor' ? 'EDITOR' : 'VIEWER');
    var chipCls = 'chip-role chip-role-' + role;
    var chipBg = role === 'owner' ? 'linear-gradient(135deg,#ede9fe,#ddd6fe)'
              : role === 'editor' ? '#dbeafe'
              : '#f3f4f6';
    var chipColor = role === 'owner' ? '#6d28d9' : role === 'editor' ? '#1e40af' : '#4b5563';
    var chipBorder = role === 'owner' ? '#c4b5fd' : role === 'editor' ? '#bfdbfe' : '#e5e7eb';
    return (
      '<div id="topbarUserInfo" style="display:flex;align-items:center;gap:8px;margin-left:auto;margin-right:12px;font-size:13px;color:var(--text-secondary)">' +
        '<span>欢迎，<b style="color:var(--text)" id="tbEmail">' + email + '</b></span>' +
        '<span id="tbRoleChip" class="' + chipCls + '" style="display:inline-block;padding:3px 10px;border-radius:12px;font-size:11px;font-weight:600;background:' + chipBg + ';color:' + chipColor + ';border:1px solid ' + chipBorder + '">' + roleLabel + '</span>' +
      '</div>'
    );
  }

  // 顶栏租户徽章
  function buildTenantBadge(tenant) {
    var name = escapeHtml(tenant.name || '杂志管理平台');
    var slug = escapeHtml(tenant.slug || '');
    var logoUrl = tenant.logo_url || '';
    var color = tenant.primary_color || '#4f46e5';
    var initial = (name && name.length) ? name.charAt(0) : '📚';
    return (
      '<div class="tenant-badge" id="tenantBadge" title="' + escapeHtml(slug) + '">' +
        '<div class="tenant-badge-fallback" id="tenantBadgeFallback" style="background:' + escapeHtml(color) + '">' + escapeHtml(initial) + '</div>' +
        '<div class="tenant-badge-name" id="tenantBadgeName">' + name + (slug ? '<code>' + slug + '</code>' : '') + '</div>' +
      '</div>'
    );
  }

  function populateRichSidebarLogo(tenant) {
    var textEl = document.getElementById('sidebarLogoText');
    var subEl = document.getElementById('sidebarLogoSub');
    var fbEl = document.getElementById('sidebarLogoFallback');
    if (textEl) textEl.textContent = tenant.name || '杂志管理平台';
    if (subEl) {
      var sub = tenant.is_platform_admin
        ? '👑 平台管理员 · SaaS · v4'
        : ('租户 · ' + (tenant.slug || ''));
      subEl.textContent = sub;
    }
    if (fbEl && tenant.name) fbEl.textContent = tenant.name.charAt(0);

    // 注：侧栏 logo 不渲染上传的图片 —— 统一只显示「租户名首字 + 租户名 + 副标」
    // 原因：上传图片在小尺寸 (32x32) 下容易糊，文字 fallback 更清晰稳定
    // 上传的 logo 仍保留在 data 里，branding 页可以预览/删除
  }

  function populateTopbarUserInfo(user) {
    var emailEl = document.getElementById('tbEmail');
    if (emailEl) emailEl.textContent = (user && user.email) || '';
    var chipEl = document.getElementById('tbRoleChip');
    if (chipEl) {
      var role = (user && user.role) || 'viewer';
      var roleLabel = role === 'owner' ? 'OWNER' : (role === 'editor' ? 'EDITOR' : 'VIEWER');
      chipEl.textContent = roleLabel;
      chipEl.className = 'chip-role chip-role-' + role;
      chipEl.style.background = role === 'owner' ? 'linear-gradient(135deg,#ede9fe,#ddd6fe)'
                             : role === 'editor' ? '#dbeafe'
                             : '#f3f4f6';
      chipEl.style.color = role === 'owner' ? '#6d28d9' : role === 'editor' ? '#1e40af' : '#4b5563';
      chipEl.style.border = role === 'owner' ? '1px solid #c4b5fd' : role === 'editor' ? '1px solid #bfdbfe' : '1px solid #e5e7eb';
    }
  }

  function populateTenantBadge(tenant) {
    var badge = document.getElementById('tenantBadge');
    if (!badge) return;
    var nameEl = document.getElementById('tenantBadgeName');
    var fbEl = document.getElementById('tenantBadgeFallback');
    if (nameEl) {
      nameEl.textContent = '';
      var span = document.createElement('span');
      span.textContent = tenant.name || '杂志管理平台';
      nameEl.appendChild(span);
      if (tenant.slug) {
        var code = document.createElement('code');
        code.textContent = tenant.slug;
        nameEl.appendChild(code);
      }
    }
    if (fbEl) {
      fbEl.style.background = tenant.primary_color || '#4f46e5';
      fbEl.textContent = (tenant.name && tenant.name.length) ? tenant.name.charAt(0) : '📚';
    }
    if (tenant.logo_url) {
      var oldImg = badge.querySelector('img');
      if (oldImg) oldImg.remove();
      var img = document.createElement('img');
      img.src = tenant.logo_url;
      img.alt = tenant.name || 'logo';
      img.style.cssText = 'width:24px;height:24px;object-fit:contain;border-radius:50%;';
      img.onerror = function () { img.style.display = 'none'; if (fbEl) fbEl.style.display = ''; };
      badge.insertBefore(img, fbEl);
      if (fbEl) fbEl.style.display = 'none';
    }
    badge.title = tenant.slug || '';
  }

  function injectUserInfoIfMissing(user) {
    var topbar = document.querySelector('.top-bar');
    if (!topbar) return;
    if (document.getElementById('topbarUserInfo')) {
      populateTopbarUserInfo(user);
      return;
    }
    // 找退出登录按钮，插在它前面
    var logoutBtn = topbar.querySelector('button[onclick*="logout"]')
                 || topbar.querySelector('button[onclick*="MAG_AUTH.logout"]')
                 || Array.prototype.find.call(topbar.querySelectorAll('button'), function (b) { return /退出/.test(b.textContent); });
    if (logoutBtn) {
      logoutBtn.insertAdjacentHTML('beforebegin', buildTopbarUserInfo(user));
    } else {
      topbar.insertAdjacentHTML('beforeend', buildTopbarUserInfo(user));
    }
  }

  function ensureRichSidebarLogo(tenant) {
    var rich = document.getElementById('sidebarLogo');
    if (rich) {
      populateRichSidebarLogo(tenant);
      return;
    }
    // 没有富版（其他页是简单文本），找 .sidebar-logo 替换
    var simple = document.querySelector('.sidebar-logo');
    if (simple) {
      simple.outerHTML = buildRichSidebarLogo(tenant);
    }
  }

  function ensureRichTenantBadge(tenant) {
    if (document.getElementById('tenantBadge')) {
      populateTenantBadge(tenant);
      return;
    }
    // 注入到 topbar（user info 之前、退出登录之前）
    var topbar = document.querySelector('.top-bar');
    if (!topbar) return;
    var html = buildTenantBadge(tenant);
    // 优先插在 #topbarUserInfo 之后；否则插在退出登录前
    var userInfo = document.getElementById('topbarUserInfo');
    if (userInfo) {
      userInfo.insertAdjacentHTML('afterend', html);
    } else {
      var logoutBtn = topbar.querySelector('button[onclick*="logout"]')
                   || topbar.querySelector('button[onclick*="MAG_AUTH.logout"]')
                   || Array.prototype.find.call(topbar.querySelectorAll('button'), function (b) { return /退出/.test(b.textContent); });
      if (logoutBtn) {
        logoutBtn.insertAdjacentHTML('beforebegin', html);
      } else {
        topbar.insertAdjacentHTML('beforeend', html);
      }
    }
  }

  window.MAG_TOPBAR = {
    /**
     * 渲染顶栏 + 侧边栏 logo（自动适配 index.html 的富版 vs 其他页的简单版）
     * 设计：每页只 1 个 logo = 侧边栏左上角那个。顶栏不放租户徽章（避免重复 + 让 user info 推到右）
     * @param {{tenant:object, user:object}} ctx
     */
    render: function (ctx) {
      if (!ctx) return;
      var tenant = ctx.tenant || {};
      var user = ctx.user || {};
      ensureRichSidebarLogo(tenant);
      // 顶栏只放 user info（推到右），不放租户徽章 —— 租户身份在侧栏已经有了
      injectUserInfoIfMissing(user);
    }
  };
})();
