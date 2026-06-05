// SMTP helper：发邮件（密码重置、注册验证、邀请、计费通知）
// 配置：.env 加
//   SMTP_HOST=smtp.exmail.qq.com
//   SMTP_PORT=465
//   SMTP_SECURE=true
//   SMTP_USER=noreply@yourcompany.com
//   SMTP_PASS=xxx
//   SMTP_FROM="杂志管理平台 <noreply@yourcompany.com>"
// 没配置时 fallback 到 console.log（开发用）
const db = require('./db/init');

let transporter = null;

function init() {
  if (transporter) return transporter;
  if (!process.env.SMTP_HOST) {
    console.log('[smtp] SMTP not configured — emails will be logged to console only');
    return null;
  }
  try {
    const nodemailer = require('nodemailer');
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 465,
      secure: (process.env.SMTP_SECURE || 'true') === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });
    console.log('[smtp] initialized, host=' + process.env.SMTP_HOST);
  } catch (e) {
    console.error('[smtp] init failed:', e.message);
  }
  return transporter;
}

async function sendMail({ to, subject, html, text }) {
  const from = process.env.SMTP_FROM || ('杂志管理平台 <noreply@localhost>');
  const body = { from, to, subject, html: html || text, text };
  const t = init();
  if (!t) {
    // 没配 SMTP：console.log + 记 email_log（status=pending）
    console.log('[smtp:console] ----- EMAIL -----');
    console.log('  to: ' + to);
    console.log('  subject: ' + subject);
    console.log('  body:');
    console.log((text || html || '').split('\n').map(l => '    ' + l).join('\n'));
    console.log('[smtp:console] ----- END EMAIL -----');
    db.logEmail({ to_email: to, subject, body: text || html, status: 'pending' });
    return { messageId: 'console-' + Date.now(), preview: '(SMTP not configured — see console)' };
  }
  try {
    const info = await t.sendMail(body);
    db.logEmail({ to_email: to, subject, body: text || html, status: 'sent' });
    return info;
  } catch (e) {
    console.error('[smtp] sendMail failed:', e.message);
    db.logEmail({ to_email: to, subject, body: text || html, status: 'failed', error: e.message });
    throw e;
  }
}

module.exports = { sendMail, init };
