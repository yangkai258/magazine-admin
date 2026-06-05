#!/usr/bin/env node
/**
 * Build script: 打包阅读端子集 (splash.html / directory.html / reader/ / images/ / config.js)
 * 输出: dist/magazine-reader-v{version}.zip
 *
 * Usage: npm run build:reader
 *
 * 兼容性说明:
 *   archiver >= 8.0 是纯 ESM 包 (package.json 声明 "type": "module"),
 *   这里用动态 import() 加载, 保持本脚本为 CommonJS.
 */

'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');
const BUILD_DIR = path.join(PROJECT_ROOT, 'build');
const DIST_DIR = path.join(PROJECT_ROOT, 'dist');

// 白名单: 相对项目根的路径
//  - type: 'file' = 必须是文件
//  - type: 'dir'  = 整个目录递归
const WHITELIST = [
  { rel: 'public/splash.html', type: 'file' },
  { rel: 'public/directory.html', type: 'file' },
  { rel: 'public/config.js', type: 'file' },
  { rel: 'public/reader', type: 'dir' },
  { rel: 'public/images', type: 'dir' },
];

function log(msg) {
  console.log(`[build-reader] ${msg}`);
}

function readPackageVersion() {
  const pkgPath = path.join(PROJECT_ROOT, 'package.json');
  const raw = fs.readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(raw);
  return (typeof pkg.version === 'string' && pkg.version.trim()) ? pkg.version.trim() : '0.0.0';
}

async function copyDirRecursive(srcDir, destDir) {
  await fsp.mkdir(destDir, { recursive: true });
  const entries = await fsp.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(srcDir, entry.name);
    const d = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirRecursive(s, d);
    } else if (entry.isFile()) {
      await fsp.copyFile(s, d);
    } else if (entry.isSymbolicLink()) {
      // 跟随符号链接, 取真实文件复制
      const real = await fsp.realpath(s);
      const stat = await fsp.stat(real);
      if (stat.isFile()) {
        await fsp.copyFile(real, d);
      }
    }
  }
}

async function copyWhitelistToBuild() {
  // 清理 + 重建 build/
  await fsp.rm(BUILD_DIR, { recursive: true, force: true });
  await fsp.mkdir(BUILD_DIR, { recursive: true });

  let copied = 0;
  let skipped = 0;

  for (const item of WHITELIST) {
    const src = path.join(PROJECT_ROOT, item.rel);
    const dest = path.join(BUILD_DIR, item.rel);

    if (!fs.existsSync(src)) {
      console.warn(`[build-reader] [warn] missing ${item.type}: ${item.rel} (skipping)`);
      skipped++;
      continue;
    }

    if (item.type === 'file') {
      const stat = await fsp.stat(src);
      if (!stat.isFile()) {
        throw new Error(`expected file but got non-file: ${item.rel}`);
      }
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.copyFile(src, dest);
      copied++;
      log(`copy file: ${item.rel}`);
    } else if (item.type === 'dir') {
      const stat = await fsp.stat(src);
      if (!stat.isDirectory()) {
        throw new Error(`expected directory but got non-dir: ${item.rel}`);
      }
      await copyDirRecursive(src, dest);
      copied++;
      log(`copy dir:  ${item.rel}`);
    } else {
      throw new Error(`unknown whitelist type: ${item.type}`);
    }
  }

  return { copied, skipped };
}

async function countFiles(rootDir) {
  let count = 0;
  async function walk(d) {
    let entries;
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        await walk(p);
      } else if (e.isFile()) {
        count++;
      }
    }
  }
  await walk(rootDir);
  return count;
}

function zipBuildDir(zipPath, buildDir) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const done = (bytes) => {
      if (settled) return;
      settled = true;
      resolve(bytes);
    };

    // archiver 8.x 是 ESM, 动态 import
    import('archiver').then((archiverMod) => {
      const { ZipArchive } = archiverMod;
      if (!ZipArchive) {
        fail(new Error('archiver module did not export ZipArchive — incompatible version?'));
        return;
      }
      const output = fs.createWriteStream(zipPath);
      const archive = new ZipArchive({ zlib: { level: 9 } });

      output.on('close', () => done(archive.pointer()));
      output.on('error', fail);
      archive.on('warning', (err) => {
        if (err && err.code === 'ENOENT') {
          console.warn(`[build-reader] [warn] ${err.message}`);
        } else {
          fail(err);
        }
      });
      archive.on('error', fail);

      archive.pipe(output);
      archive.directory(buildDir, false);
      archive.finalize();
    }).catch(fail);
  });
}

async function cleanupBuildDir() {
  try {
    await fsp.rm(BUILD_DIR, { recursive: true, force: true });
  } catch (err) {
    console.warn(`[build-reader] [warn] failed to clean build/: ${err.message}`);
  }
}

async function main() {
  const version = readPackageVersion();
  const zipName = `magazine-reader-v${version}.zip`;
  const zipPath = path.join(DIST_DIR, zipName);

  log(`project: ${PROJECT_ROOT}`);
  log(`version: ${version}`);
  log(`output:  ${zipPath}`);

  // 1) 拷贝白名单到 build/
  const { copied, skipped } = await copyWhitelistToBuild();
  log(`whitelist: ${copied} copied, ${skipped} skipped`);

  if (copied === 0) {
    throw new Error('no whitelisted files were copied — refusing to build an empty zip');
  }

  const fileCount = await countFiles(BUILD_DIR);
  log(`staged files: ${fileCount}`);

  // 2) 打成 zip
  await fsp.mkdir(DIST_DIR, { recursive: true });
  const bytes = await zipBuildDir(zipPath, BUILD_DIR);
  const kb = (bytes / 1024).toFixed(2);

  log(`zip path:  ${zipPath}`);
  log(`zip size:  ${kb} KB (${bytes} bytes)`);
  log(`zip files: ${fileCount}`);

  // 3) 清理 build/ 临时目录
  await cleanupBuildDir();
  log(`cleaned:   ${BUILD_DIR}`);

  log('done.');
}

// Top-level error handling
main().catch((err) => {
  console.error('[build-reader] FAILED');
  if (err && err.stack) {
    console.error(err.stack);
  } else {
    console.error(err);
  }
  process.exit(1);
});
