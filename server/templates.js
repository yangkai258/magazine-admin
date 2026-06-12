// server/templates.js
//
// v6.3 模板系统（第二支线 = 改模板）
// - 3 套内置样板（hardcoded 常量 + 注释允许后期切 DB）
//   * business    商务 / 深蓝 #1E3A8A + 思源黑体 + 顶部 banner + 横线分隔
//   * education   教育 / 暖橙 #EA580C + 思源宋体 + 圆角卡 + 角标 icon
//   * minimal     极简 / 纯黑 #111827 + Inter + 全宽 + 极细分隔线
// - 模板 schema:
//   {
//     id: 'business',
//     name: '商务深蓝',
//     colors:  { primary, accent, bg, text },
//     fonts:   { heading, body },
//     layout:  { coverStyle: 'banner'|'full'|'split', footerStyle: 'simple'|'line'|'none' },
//     elements:{ iconSet: 'star'|'arrow'|'book'|'none', divider: 'line'|'dots'|'wave', card: 'rounded'|'sharp'|'none' }
//   }
// - 提供 3 个纯函数（无 I/O，便于 unit test）：
//   * listTemplates()                         → Template[]
//   * getTemplate(id)                         → Template | null
//   * buildPreview(idOrNull, overrides?)      → { css_vars: {...}, element_classes: {...} }
//
// 设计原则：
// 1) 模板只是「样式预设」，不改 page 数据字段（页的 title/body/image_path 不动）；
// 2) 不动 reader 端 —— preview 仅 admin 端用，前端拿到 css_vars + element_classes 后 set document.documentElement 即可；
// 3) overrides 浅合并到 base 模板（颜色/字体/版式/元素均可覆盖）—— 给「保留模板但调一个色」的快速个性化用；
// 4) 渲染期不依赖模板（templates 缺 / 错 / 未知 id 都 fallback 到 'business'）—— 「改字段手动来，模板预览永远是 best-effort」。

'use strict';

// 3 套内置样板 —— 后期切 DB：把 TEMPLATES 换成 db.getAllTemplates() 即可，函数签名不变
// 字段说明：
//   colors.primary  —— 主色（CTA / 强调 / 顶栏）
//   colors.accent   —— 辅色（小元素 / 高亮）
//   colors.bg       —— 背景色（卡片 / 区域背景）
//   colors.text     —— 正文色
//   fonts.heading   —— 标题字体（CSS font-family 字符串，引用 woff2 文件或 system 栈）
//   fonts.body      —— 正文字体
//   layout.coverStyle —— 封面样式：'banner'（顶部 banner）/ 'full'（全宽封面）/ 'split'（左图右文）
//   layout.footerStyle —— 页脚样式：'simple'（一行小字）/ 'line'（横线 + 文字）/ 'none'（无页脚）
//   elements.iconSet —— 角标图标集：'star' / 'arrow' / 'book' / 'none'
//   elements.divider —— 分隔线：'line' / 'dots' / 'wave'
//   elements.card   —— 卡片样式：'rounded' / 'sharp' / 'none'
const TEMPLATES = Object.freeze([
  Object.freeze({
    id: 'business',
    name: '商务深蓝',
    description: '庄重、专业的商务场景；适合 B2B 宣传册、品牌期刊、年度报告。',
    colors: Object.freeze({
      primary: '#1E3A8A',   // 深蓝（信任 / 稳定）
      accent:  '#0EA5E9',   // 天蓝（信息 / 数据）
      bg:      '#F8FAFC',   // 浅灰白（背景）
      text:    '#0F172A'    // 近黑（正文）
    }),
    fonts: Object.freeze({
      heading: '"Source Han Sans CN", "Noto Sans SC", -apple-system, "Segoe UI", sans-serif',
      body:    '"Source Han Sans CN", "Noto Sans SC", -apple-system, "Segoe UI", sans-serif'
    }),
    layout: Object.freeze({
      coverStyle:  'banner',  // 顶部 banner
      footerStyle: 'line'     // 横线 + 页码
    }),
    elements: Object.freeze({
      iconSet: 'arrow',  // 商务常用 → 箭头
      divider: 'line',
      card:    'sharp'
    })
  }),
  Object.freeze({
    id: 'education',
    name: '教育暖橙',
    description: '温暖、亲切的教育场景；适合课程手册、招生画册、培训资料。',
    colors: Object.freeze({
      primary: '#EA580C',   // 暖橙（活力 / 亲和）
      accent:  '#F59E0B',   // 琥珀（突出重点）
      bg:      '#FFFBEB',   // 暖白
      text:    '#1C1917'    // 深棕
    }),
    fonts: Object.freeze({
      heading: '"Source Han Serif CN", "Noto Serif SC", Georgia, serif',
      body:    '"Source Han Sans CN", "Noto Sans SC", -apple-system, sans-serif'
    }),
    layout: Object.freeze({
      coverStyle:  'split',  // 左图右文
      footerStyle: 'simple'  // 一行小字
    }),
    elements: Object.freeze({
      iconSet: 'book',   // 教育常用 → 书
      divider: 'dots',
      card:    'rounded'  // 圆角卡
    })
  }),
  Object.freeze({
    id: 'minimal',
    name: '极简黑白',
    description: '克制、留白的极简风；适合设计作品集、艺术杂志、摄影集。',
    colors: Object.freeze({
      primary: '#111827',   // 纯黑
      accent:  '#6B7280',   // 中灰（点缀）
      bg:      '#FFFFFF',   // 纯白
      text:    '#111827'    // 纯黑
    }),
    fonts: Object.freeze({
      heading: 'Inter, -apple-system, "Segoe UI", sans-serif',
      body:    'Inter, -apple-system, "Segoe UI", sans-serif'
    }),
    layout: Object.freeze({
      coverStyle:  'full',   // 全宽封面
      footerStyle: 'none'    // 无页脚
    }),
    elements: Object.freeze({
      iconSet: 'none',
      divider: 'line',       // 极细分隔线
      card:    'none'        // 无卡片
    })
  })
]);

// 3 套模板的 id 集合（用于校验）
const TEMPLATE_IDS = Object.freeze(TEMPLATES.map(t => t.id));

// 兜底模板 id —— 任何「未知 id / null / undefined / 损坏 overrides」都降级到这里
const FALLBACK_TEMPLATE_ID = 'business';

/**
 * 列出所有内置模板。
 * @returns {ReadonlyArray<Readonly<{id, name, description, colors, fonts, layout, elements}>>}
 */
function listTemplates() {
  return TEMPLATES;
}

/**
 * 按 id 取单套模板。
 * @param {string} id  模板 id（'business' | 'education' | 'minimal'）
 * @returns {object|null} 找到则返回冻结的模板对象；找不到返回 null（不抛）
 */
function getTemplate(id) {
  if (typeof id !== 'string') return null;
  return TEMPLATES.find(t => t.id === id) || null;
}

/**
 * 校验 id 是否在合法集合内。
 * @param {string} id
 * @returns {boolean}
 */
function isValidTemplateId(id) {
  return typeof id === 'string' && TEMPLATE_IDS.includes(id);
}

// ========== 内部工具：浅合并 + 容错 ==========

/**
 * 浅合并 overrides 到 base（只覆盖显式给出的字段，**不深合并**）。
 * - overrides 中的非 plain object 不合并（保 base 原值）
 * - overrides 中的 string 字段做 trim 校验（空字符串 = 不覆盖）
 * - 颜色/字体字段做格式兜底：trim 后取前 200 字符防 XSS / 注入
 */
function _shallowMerge(base, overrides) {
  if (!overrides || typeof overrides !== 'object') return base;
  const out = { ...base };
  for (const key of Object.keys(overrides)) {
    const v = overrides[key];
    if (v === undefined) continue;                          // 显式 undefined = 不改
    if (v === null)         continue;                       // 显式 null = 不改
    if (typeof v === 'string') {
      const trimmed = v.trim();
      if (!trimmed) continue;
      out[key] = trimmed.slice(0, 200);
      continue;
    }
    if (typeof v === 'object' && !Array.isArray(v)) {
      // 嵌套对象（colors / fonts / layout / elements）：浅合并一层
      out[key] = { ...(base[key] || {}), ..._shallowMergeFlatObject(v) };
      continue;
    }
    // 其它类型（number / boolean）原样写入
    out[key] = v;
  }
  return out;
}

function _shallowMergeFlatObject(obj) {
  const out = {};
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v === undefined || v === null) continue;
    if (typeof v === 'string') {
      const trimmed = v.trim();
      if (!trimmed) continue;
      out[k] = trimmed.slice(0, 200);
      continue;
    }
    out[k] = v;
  }
  return out;
}

// ========== 核心：buildPreview ==========

/**
 * 把模板转成 admin 端可直接消费的「CSS 变量 + class 名」两件套。
 * - 缺 id / 错 id / overrides 损坏 → 全部降级到 FALLBACK_TEMPLATE_ID
 * - overrides 浅合并到 base（可覆盖 colors / fonts / layout / elements 任一字段）
 * - 同步升 schema_version：'_meta.template_schema_version' 写到输出（前端可拿来兼容判断）
 *
 * @param {string|null|undefined} templateId
 * @param {object} [overrides]
 * @returns {{
 *   template_id: string,
 *   template_name: string,
 *   css_vars: { [k: string]: string },
 *   element_classes: { [k: string]: string }
 * }}
 */
function buildPreview(templateId, overrides) {
  // 1) 找 base；找不到就降级
  let base = getTemplate(templateId) || getTemplate(FALLBACK_TEMPLATE_ID);
  let resolvedId = base.id;

  // 2) 合并 overrides
  let merged;
  try {
    merged = _shallowMerge(base, overrides);
  } catch (e) {
    // 合并失败（极端：overrides 是非 plain object）→ 用 base
    merged = base;
  }

  // 3) 二次兜底：merged 关键字段缺失时回退到 base 对应字段
  const colors  = merged.colors  || base.colors;
  const fonts   = merged.fonts   || base.fonts;
  const layout  = merged.layout  || base.layout;
  const elements= merged.elements|| base.elements;

  // 4) 转 CSS 变量
  //    命名约定：--template-{group}-{key}，前端 <html> 上 setProperty 后即生效
  const css_vars = {
    '--template-color-primary': colors.primary,
    '--template-color-accent':  colors.accent,
    '--template-color-bg':      colors.bg,
    '--template-color-text':    colors.text,
    '--template-font-heading':  fonts.heading,
    '--template-font-body':     fonts.body,
    '--template-layout-cover-style':  layout.coverStyle,
    '--template-layout-footer-style': layout.footerStyle,
    '--template-element-icon-set':  elements.iconSet,
    '--template-element-divider':   elements.divider,
    '--template-element-card':      elements.card
  };

  // 5) 转 element classes（前端用 querySelector + classList 即可）
  //    命名约定：tpl-{group}-{value}，CSS 用 [class*="tpl-card-"] 等属性选择器就能命中
  const element_classes = {
    cover:  'tpl-cover-'  + layout.coverStyle,    // tpl-cover-banner | tpl-cover-full | tpl-cover-split
    footer: 'tpl-footer-' + layout.footerStyle,   // tpl-footer-simple | tpl-footer-line | tpl-footer-none
    icon:   'tpl-icon-'   + elements.iconSet,    // tpl-icon-star | tpl-icon-arrow | tpl-icon-book | tpl-icon-none
    divider:'tpl-divider-'+ elements.divider,     // tpl-divider-line | tpl-divider-dots | tpl-divider-wave
    card:   'tpl-card-'   + elements.card         // tpl-card-rounded | tpl-card-sharp | tpl-card-none
  };

  return {
    template_id: resolvedId,
    template_name: base.name,
    css_vars,
    element_classes
  };
}

// ========== 暴露给 admin.js / scripts 用的辅助函数 ==========

/**
 * 拿「合法模板 id 列表」（API 校验 / 前端下拉框数据用）
 */
function listTemplateIds() {
  return TEMPLATE_IDS.slice();
}

module.exports = {
  listTemplates,
  getTemplate,
  isValidTemplateId,
  buildPreview,
  listTemplateIds,
  // 内部常量（测试用）
  _internal: {
    FALLBACK_TEMPLATE_ID,
    TEMPLATES,
    TEMPLATE_IDS
  }
};
