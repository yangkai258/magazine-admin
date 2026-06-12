// 在 canvas 目录里手动调 node-pre-gyp install
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = 'C:\\Users\\YKing\\.openclaw\\workspace\\magazine-admin';
const canvasDir = path.join(root, 'node_modules', 'canvas');
const logPath = path.join(root, 'npm-install-pdf.log');

function log(msg) {
  fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`);
}

fs.appendFileSync(logPath, '\n[step] try to fetch prebuilt canvas binary via node-pre-gyp\n');

const child = spawn('cmd.exe', ['/c', 'npm.cmd', 'run', 'install'], {
  cwd: canvasDir,
  windowsHide: true
});

child.stdout.on('data', d => fs.appendFileSync(logPath, 'OUT: ' + d.toString().slice(-300)));
child.stderr.on('data', d => fs.appendFileSync(logPath, 'ERR: ' + d.toString().slice(-300)));
child.on('error', e => fs.appendFileSync(logPath, 'SPAWN-ERR: ' + e.message));
child.on('close', code => {
  fs.appendFileSync(logPath, '[done] close code=' + code + '\n');
  // 检查 binary
  const binPath = path.join(canvasDir, 'build', 'Release', 'canvas.node');
  fs.appendFileSync(logPath, '[verify] binary exists: ' + fs.existsSync(binPath) + '\n');
  process.exit(0);
});
