// 启动脚本：公共阅读端 50100 / 后台 50120 + ADMIN_PASSWORD
// 原因：Windows 下通过 cmd /c set X=Y && node ... 启动子进程时 env vars 经常不生效（特别是 schtasks 派生的进程）。
//      这个 wrapper 直接在 Node 进程内 setenv，再 require server，永远可靠。
//
// 用法：
//   node scripts/start-50120.js
// 或
//   C:\Users\YKing\start-server-50120.bat  （仓库外的快捷启动器）
process.env.PUBLIC_PORT = '50100';
process.env.ADMIN_PORT = '50120';
process.env.ADMIN_PASSWORD = 'MagAdmin2026ChangeMe';
require('../server/index.js');
