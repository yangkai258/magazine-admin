// 支付 helper：支付宝 + 微信
// 支付宝：电脑网站支付 / 手机网站支付（notify_url 异步通知）
// 微信：JSAPI / Native（扫码）
//
// 真实接入需要：
//   - 支付宝商户号 + 应用 APPID + RSA2 私钥/公钥
//   - 微信支付商户号 + AppID + API v3 密钥
//
// 沙箱：支付宝有开放平台沙箱环境，签名用公钥测试
//
// .env 必备（生产）：
//   ALIPAY_APP_ID=2021000000000000
//   ALIPAY_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n..."
//   ALIPAY_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----\n..."
//   ALIPAY_NOTIFY_URL=https://yourdomain.com/api/payment/alipay/notify
//   WECHAT_MCH_ID=1234567890
//   WECHAT_APP_ID=wx...
//   WECHAT_API_KEY=v3...
//   WECHAT_NOTIFY_URL=https://yourdomain.com/api/payment/wechat/notify
//
// 没配置时：直接返回 mock 订单（开发用）

const crypto = require('crypto');
const db = require('./db/init');

function alipayConfigured() {
  return !!(process.env.ALIPAY_APP_ID && process.env.ALIPAY_PRIVATE_KEY);
}
function wechatConfigured() {
  return !!(process.env.WECHAT_MCH_ID && process.env.WECHAT_API_KEY);
}

// ========== 支付宝：创建订单（电脑网站支付） ==========
async function createAlipayOrder({ invoice_id, amount_cny, subject }) {
  if (!alipayConfigured()) {
    // 开发 mock
    const mockTradeNo = 'MOCK_ALIPAY_' + Date.now() + '_' + invoice_id;
    console.log('[payment:alipay:mock] invoice=' + invoice_id + ' amount=' + amount_cny + ' trade_no=' + mockTradeNo);
    return { method: 'mock', out_trade_no: mockTradeNo, pay_url: '/admin/payment-mock?invoice=' + invoice_id + '&method=alipay' };
  }
  // 真实接入留接口（用 alipay-sdk 或自己签名）
  // TODO: 用 AlipaySdk 客户端创建订单
  // 这里返回占位，部署时接入真实 SDK
  const out_trade_no = 'MAG' + Date.now() + invoice_id;
  return { method: 'alipay', out_trade_no, pay_url: null /* TODO */ };
}

// ========== 支付宝：验证 notify 回调（验签 + 处理） ==========
function verifyAlipayNotify(params) {
  // TODO: 用 ALIPAY_PUBLIC_KEY 验签
  // 验签通过 + trade_status=TRADE_SUCCESS/TRADE_FINISHED → 标记 invoice 为 paid
  return { verified: false, reason: 'real_alipay_not_implemented_yet' };
}

// ========== 微信支付：创建订单（Native 扫码） ==========
async function createWechatOrder({ invoice_id, amount_cny, subject }) {
  if (!wechatConfigured()) {
    const mockTradeNo = 'MOCK_WECHAT_' + Date.now() + '_' + invoice_id;
    console.log('[payment:wechat:mock] invoice=' + invoice_id + ' amount=' + amount_cny + ' out_trade_no=' + mockTradeNo);
    return { method: 'mock', out_trade_no: mockTradeNo, pay_url: '/admin/payment-mock?invoice=' + invoice_id + '&method=wechat' };
  }
  // 真实接入用 wechatpay-node-v3 或自己签
  const out_trade_no = 'MAG' + Date.now() + invoice_id;
  return { method: 'wechat', out_trade_no, pay_url: null /* TODO */ };
}

// ========== 微信支付：验证 notify 回调 ==========
function verifyWechatNotify(headers, body) {
  // TODO: 用 WECHAT_API_KEY 验证签名
  return { verified: false, reason: 'real_wechat_not_implemented_yet' };
}

// ========== 标记 invoice 支付成功（统一处理） ==========
function markInvoicePaid({ invoice_id, out_trade_no, paid_at, payment_method }) {
  const inv = db.updateInvoice(invoice_id, { status: 'paid', paid_at: paid_at || new Date().toISOString(), external_id: out_trade_no, payment_method });
  if (!inv) return null;
  // 创建/延长订阅
  const plan = db.getPlan(inv.plan_id);
  const ends = new Date(inv.period_end || Date.now() + 30 * 24 * 3600 * 1000).toISOString();
  // 取消该租户的旧 active 订阅
  const allSubs = (db.getActiveSubscription && []) || [];
  // 简化：直接创建新订阅
  db.createSubscription({ tenant_id: inv.tenant_id, plan_id: inv.plan_id, started_at: new Date().toISOString(), ends_at: ends, status: 'active', external_id: out_trade_no });
  // 更新 tenant.plan_id
  db.updateTenant(inv.tenant_id, { plan_id: inv.plan_id, subscription_status: 'active' });
  return inv;
}

module.exports = {
  alipayConfigured, wechatConfigured,
  createAlipayOrder, verifyAlipayNotify,
  createWechatOrder, verifyWechatNotify,
  markInvoicePaid
};
