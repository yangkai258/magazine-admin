// v6.2 PDF 智能解析：PDF → page images
//
// 设计要点：
//   1. pdf-img-convert v2 是 ESM（import/export），magazine-admin 是 CJS，
//      所以用 dynamic import() 包装。
//   2. pdf-img-convert 底层依赖 `canvas` (native!) 把 pdfjs 渲染结果转 buffer。
//      在 Windows + 无 Python / 无 MSVC 的环境下，canvas 的 native binary 装不上，
//      任何 convert() 调用都会在 require 阶段就抛 `Cannot find module canvas.node`。
//   3. 本模块对底层错误做明确归类（具体见 ERR_CODE 表），调用方（import-pdf 端点）可
//      按错误码决定「失败 503」还是「降级创建空壳 magazine + 提示用户」。
//   4. 不传 OSS；输出直接落 `uploads/skeleton/<magazineId>/page-N.png`，由调用方负责写盘。
//   5. 默认 width=1200（约 A4 横版宽度的 2 倍），高度等比例。maxPages 默认 30（env PDF_MAX_PAGES）。
//
// 错误码：
//   ERR_PDF_RENDER_DEP_MISSING  canvas 二进制缺失（沙箱 / 镜像漏装），需要装 libpng + cairo
//   ERR_PDF_RENDER_FAILED       解析时其它异常（PDF 加密 / 损坏 / 内存不足）
//   ERR_PDF_EMPTY               PDF 0 页（合法但无内容）

'use strict';

const DEFAULT_MAX_PAGES = Math.max(1, Number(process.env.PDF_MAX_PAGES) || 30);
const DEFAULT_WIDTH = 1200;  // 输出 PNG 宽度，高度由 pdfjs 按 viewport 比例算

class PdfRenderError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'PdfRenderError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

/**
 * 异步加载 pdf-img-convert（ESM 动态 import）。失败抛 PdfRenderError(ERR_PDF_RENDER_DEP_MISSING)。
 * 用 module 级缓存避免每次请求都重新 import（dynamic import 内部已缓存，但我们额外保护一层日志去重）。
 */
let _convertModulePromise = null;
async function _loadConvert() {
  if (_convertModulePromise) return _convertModulePromise;
  _convertModulePromise = (async () => {
    try {
      const mod = await import('pdf-img-convert');
      if (!mod || typeof mod.convert !== 'function') {
        throw new PdfRenderError('ERR_PDF_RENDER_DEP_MISSING',
          'pdf-img-convert loaded but has no convert() export');
      }
      return mod;
    } catch (e) {
      // 典型：canvas native binary 缺失
      // 错误信息通常含 "Cannot find module '...canvas.node'" 或 "Could not load"
      const msg = e && e.message ? e.message : String(e);
      const isDepMissing = /canvas\.node|Could not load|DLL|specified module/i.test(msg);
      throw new PdfRenderError(
        isDepMissing ? 'ERR_PDF_RENDER_DEP_MISSING' : 'ERR_PDF_RENDER_FAILED',
        'pdf-img-convert dynamic import failed: ' + msg,
        e
      );
    }
  })();
  return _convertModulePromise;
}

/**
 * 把 PDF buffer 解析成 page image buffers。
 * @param {Object} opts
 * @param {Buffer} opts.buffer              PDF 二进制 buffer
 * @param {number} [opts.maxPages=30]       最多抽多少页（超出截断）
 * @param {number} [opts.width=1200]        输出 PNG 宽度
 * @returns {Promise<Array<{ index: number, imageBuffer: Buffer, mime: 'image/png' }>>}
 * @throws {PdfRenderError}                 错误码见上
 */
async function parsePdfToPages({ buffer, maxPages, width } = {}) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new PdfRenderError('ERR_PDF_RENDER_FAILED', 'buffer 必须是非空 Buffer');
  }
  const limit = Math.max(1, Math.min(200, Number(maxPages) || DEFAULT_MAX_PAGES));
  const targetWidth = Math.max(200, Math.min(4000, Number(width) || DEFAULT_WIDTH));

  const { convert } = await _loadConvert();

  let pageNumbers;
  let pngPages;
  const startedAt = Date.now();
  try {
    // pdf-img-convert v2 在传 width 时按宽度等比缩放；height 会被忽略
    // 注：pdf-img-convert 用 node-fetch 来 fetch URL；我们传 Buffer，它会走 Uint8Array 路径
    const pdfBytes = new Uint8Array(buffer);  // pdf-img-convert 接受 Buffer / Uint8Array / string(URL|file)
    // 先取一次只读 metadata 来算页数
    // 注：pdf-img-convert 没暴露 numPages 方法，但 convert(pdf, { page_numbers: [...] }) 支持指定页码
    // 我们先传 page_numbers: [1..limit]，对少于 limit 页的 PDF 它会自动跳过无效页
    pageNumbers = Array.from({ length: limit }, (_, i) => i + 1);
    pngPages = await convert(pdfBytes, { page_numbers: pageNumbers, width: targetWidth });
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    // 区分 dep 缺失和真正的解析失败
    const isDepMissing = /canvas\.node|Could not load|DLL|specified module/i.test(msg);
    throw new PdfRenderError(
      isDepMissing ? 'ERR_PDF_RENDER_DEP_MISSING' : 'ERR_PDF_RENDER_FAILED',
      'pdf-img-convert.convert failed: ' + msg,
      e
    );
  }
  const duration_ms = Date.now() - startedAt;

  if (!Array.isArray(pngPages) || pngPages.length === 0) {
    throw new PdfRenderError('ERR_PDF_EMPTY', 'PDF 解析返回空（0 页或全部页无效）');
  }

  // pdf-img-convert 返回 Uint8Array 数组（base64=false）；统一转 Buffer
  const pages = pngPages
    .map((u8, i) => {
      if (!u8) return null;
      const imageBuffer = Buffer.isBuffer(u8) ? u8 : Buffer.from(u8);
      return { index: i + 1, imageBuffer, mime: 'image/png' };
    })
    .filter(Boolean)
    // 兜底：截断到 maxPages
    .slice(0, limit);

  console.log(`[pdf-parser] parsePdfToPages ok pages=${pages.length}/${limit} width=${targetWidth} duration_ms=${duration_ms} buffer_kb=${Math.round(buffer.length / 1024)}`);
  return pages;
}

module.exports = {
  parsePdfToPages,
  PdfRenderError,
  // 内部/测试用
  _internal: { _loadConvert, DEFAULT_MAX_PAGES, DEFAULT_WIDTH }
};
