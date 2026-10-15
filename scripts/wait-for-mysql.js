#!/usr/bin/env node
/**
 * scripts/wait-for-mysql.js — 等 MySQL/MariaDB 可连接后再继续（Docker/K8s 启动前置）
 *
 * 为什么需要：server.js 的 ensureSchema() 在 listen 回调里执行且**不重试**，
 * 数据库没就绪时建表会静默失败（看板报错、要手动重启）。compose 的
 * depends_on: service_healthy 覆盖了常规情况；本脚本作为双保险，
 * 也方便 K8s initContainer / 裸 docker run 复用。
 *
 * 连接参数与 db.js 同规则：环境变量优先（MYSQL_HOST/MYSQL_PORT/MYSQL_USER/
 * MYSQL_PASSWORD/MYSQL_DATABASE），缺省值对齐本机便携 MariaDB。
 *
 * 退出码：0 = 连上了；1 = 超时仍连不上（打印原因）。
 */
const mysql = require('mysql2/promise');

const host = process.env.MYSQL_HOST || '127.0.0.1';
const port = Number(process.env.MYSQL_PORT) || 3306;
const user = process.env.MYSQL_USER || 'root';
const password = process.env.MYSQL_PASSWORD === undefined ? '' : String(process.env.MYSQL_PASSWORD);
const database = process.env.MYSQL_DATABASE || 'invoice_bot';
const timeoutMs = Number(process.env.WAIT_MYSQL_TIMEOUT_MS) || 120000;
const intervalMs = Number(process.env.WAIT_MYSQL_INTERVAL_MS) || 2000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tryOnce() {
  const conn = await mysql.createConnection({
    host, port, user, password, database, connectTimeout: 4000,
  });
  await conn.query('SELECT 1');
  await conn.end();
}

(async () => {
  const t0 = Date.now();
  let lastErr = null;
  for (;;) {
    try {
      await tryOnce();
      console.log(`[wait-for-mysql] ${host}:${port}/${database} 可连接（用时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`);
      process.exit(0);
    } catch (e) {
      lastErr = e;
      if (Date.now() - t0 > timeoutMs) {
        console.error(`[wait-for-mysql] 等待 ${timeoutMs / 1000}s 后仍无法连接 ${host}:${port}/${database}（user=${user}）`);
        console.error('  最后错误: ' + (e && e.message));
        console.error('  请检查：数据库是否已启动、MYSQL_* 环境变量是否正确、容器网络是否互通');
        process.exit(1);
      }
      await sleep(intervalMs);
    }
  }
})();
