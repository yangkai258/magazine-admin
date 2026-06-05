// 同时启动公共阅读端和后台，共享同一份 db/data.json
// 端口可通过 env 覆盖：PUBLIC_PORT / ADMIN_PORT
// 默认 50020/50040：50010 被 WXWork 占、50030 留作他用
const publicApp = require('./public');
const adminApp = require('./admin');

// 端口可通过 env 覆盖：PUBLIC_PORT / ADMIN_PORT
const PUBLIC_PORT = Number(process.env.PUBLIC_PORT) || 50020;
const ADMIN_PORT = Number(process.env.ADMIN_PORT) || 50040;

publicApp.listen(PUBLIC_PORT, () => {
  console.log(`公共阅读端:   http://localhost:${PUBLIC_PORT}`);
}).on('error', (e) => {
  console.error(`[public] 端口 ${PUBLIC_PORT} 监听失败: ${e.message}（可设 PUBLIC_PORT=50021 重试）`);
});

adminApp.listen(ADMIN_PORT, () => {
  console.log(`管理后台:     http://localhost:${ADMIN_PORT}`);
}).on('error', (e) => {
  console.error(`[admin] 端口 ${ADMIN_PORT} 监听失败: ${e.message}（可设 ADMIN_PORT=50041 重试）`);
});
