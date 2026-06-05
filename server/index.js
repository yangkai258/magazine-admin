// 同时启动公共阅读端和后台，共享同一份 db/data.json
// 端口可通过 env 覆盖：PUBLIC_PORT / ADMIN_PORT
// 应对老的 30316 占着 3010/3030 杀不掉的情况：env 改成 3011/3031 即可
const publicApp = require('./public');
const adminApp = require('./admin');

// 端口可通过 env 覆盖：PUBLIC_PORT / ADMIN_PORT
const PUBLIC_PORT = Number(process.env.PUBLIC_PORT) || 3010;
const ADMIN_PORT = Number(process.env.ADMIN_PORT) || 3030;

publicApp.listen(PUBLIC_PORT, () => {
  console.log(`公共阅读端:   http://localhost:${PUBLIC_PORT}`);
}).on('error', (e) => {
  console.error(`[public] 端口 ${PUBLIC_PORT} 监听失败: ${e.message}（可能已被占，可设 PUBLIC_PORT=3011 重试）`);
});

adminApp.listen(ADMIN_PORT, () => {
  console.log(`管理后台:     http://localhost:${ADMIN_PORT}`);
}).on('error', (e) => {
  console.error(`[admin] 端口 ${ADMIN_PORT} 监听失败: ${e.message}（可设 ADMIN_PORT=3031 重试）`);
});
