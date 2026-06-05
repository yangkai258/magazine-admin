// 同时启动公共阅读端和后台，共享同一份 db/data.json
// 端口可通过 env 覆盖：PUBLIC_PORT / ADMIN_PORT
// 应对老的 30316 占着 3010/3030 杀不掉的情况：env 改成 3011/3031 即可
const publicApp = require('./public');
const adminApp = require('./admin');

// 临时硬编码 3012/3032：旧的 30316 + 13988 进程占着 3010/3011/3030/3031 杀不掉，
// 新服务绕开到 3012/3032。等下次能 kill 旧进程后再改回 3010/3030。
const PUBLIC_PORT = Number(process.env.PUBLIC_PORT) || 3012;
const ADMIN_PORT = Number(process.env.ADMIN_PORT) || 3032;

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
