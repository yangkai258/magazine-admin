// v6.1 内存限速器（每租户每日 N 次 AI 调用）
// - 纯 Node.js Map，无外部依赖
// - checkAndIncrement(tenantId, action, limit, windowMs) → { allowed, current, limit, resetAt }
// - 进程重启清空（接受；不强求持久化）
// - 每 60s 扫一次过期 entry 清理（setInterval, unref() 不阻塞进程退出）
//   设计上 key = `${tenantId}:${action}:${floor(now/windowMs)}`,超出当前桶的桶会被清掉
//   这里用「窗口对齐」+ 「当前桶保留」模式：每次扫只清掉 resetAt 已经过去的桶

'use strict';

// store: Map<key, { count, resetAt }>
//   key 格式: `${tenantId}:${action}:${windowId}` (windowId = floor(now/windowMs))
//   每个 entry 自带 resetAt,清理时直接挑 resetAt <= now 的删
const store = new Map();

// 清理间隔（默认 60s）。模块加载时启动一次 setInterval,unref() 让它不阻塞进程退出。
const SWEEP_INTERVAL_MS = 60 * 1000;

function _sweep(now) {
  // 遍历 store,删掉 resetAt 已过的桶
  let removed = 0;
  for (const [k, v] of store) {
    if (v.resetAt <= now) {
      store.delete(k);
      removed++;
    }
  }
  if (removed > 0 && process.env.NODE_ENV !== 'production') {
    console.log('[rate-limit] swept', removed, 'expired entries, remaining:', store.size);
  }
}

// 单例 setInterval,模块 require 时启一次
const _sweepTimer = setInterval(() => _sweep(Date.now()), SWEEP_INTERVAL_MS);
_sweepTimer.unref();

/**
 * 检查 + 自增。返回的 current 是「包含本次调用后的累计」值（已 increment）。
 * @param {string|number} tenantId  租户 ID（多租户隔离）
 * @param {string} action           限速动作名（如 'ai_skeleton'）
 * @param {number} limit            窗口内允许的最大次数
 * @param {number} windowMs         窗口长度（ms）。默认 24h = 86400000
 * @returns {{ allowed: boolean, current: number, limit: number, resetAt: string }}
 */
function checkAndIncrement(tenantId, action, limit, windowMs) {
  const lim = Math.max(0, Number(limit) || 0);
  const win = Math.max(1000, Number(windowMs) || 86400000);
  const now = Date.now();
  // 窗口对齐:floor(now/win) 保证同一窗口内多次调用共享一个 bucket
  const windowId = Math.floor(now / win);
  const resetAtMs = (windowId + 1) * win;
  const key = `${tenantId}:${action}:${windowId}`;

  // 顺手扫一次过期（高频调用路径上清理一些过期 entry）
  if (store.size > 1024) _sweep(now);

  const existing = store.get(key);
  const currentCount = existing ? existing.count : 0;

  if (currentCount >= lim) {
    // 已超限：返回 current（不含本次）,allowed=false
    // 注意:不 increment,超限不消耗配额
    return {
      allowed: false,
      current: currentCount,
      limit: lim,
      resetAt: new Date(resetAtMs).toISOString()
    };
  }

  // 通过：自增 1
  const nextCount = currentCount + 1;
  store.set(key, { count: nextCount, resetAt: resetAtMs });

  return {
    allowed: true,
    current: nextCount,
    limit: lim,
    resetAt: new Date(resetAtMs).toISOString()
  };
}

/**
 * 仅查询（不 increment）。给 UI / 大屏用：看当前租户剩余配额。
 * @returns {{ current: number, limit: number, resetAt: string } | null}
 */
function peek(tenantId, action, limit, windowMs) {
  const lim = Math.max(0, Number(limit) || 0);
  const win = Math.max(1000, Number(windowMs) || 86400000);
  const now = Date.now();
  const windowId = Math.floor(now / win);
  const resetAtMs = (windowId + 1) * win;
  const key = `${tenantId}:${action}:${windowId}`;
  const existing = store.get(key);
  return {
    current: existing ? existing.count : 0,
    limit: lim,
    resetAt: new Date(resetAtMs).toISOString()
  };
}

/**
 * 内部/测试用:清空 store
 */
function _reset() {
  store.clear();
}

/**
 * 内部/测试用:当前 entry 数
 */
function _size() {
  return store.size;
}

module.exports = {
  checkAndIncrement,
  peek,
  // 内部导出（测试用）
  _reset,
  _size,
  _sweep
};
