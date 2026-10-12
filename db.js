/**
 * db.js — MySQL 连接池与建库工具（server.js / import-to-db.js 共用）
 *
 * 连接参数取自 config.json 的 mysql 段：
 *   { host, port, user, password, database, connectionLimit }
 *
 * 约定：
 *   - dateStrings=true  → DATETIME 以 'YYYY-MM-DD HH:mm:ss' 字符串返回，避免时区漂移
 *   - decimalNumbers=true → DECIMAL 以 Number 返回，看板可直接做算术
 */
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DEFAULT_DB = 'invoice_bot';
const SEND_LOG_COMMENT = '催收消息发送记录（一行=一次发送，看板统计催收次数与最近催收时间）';

/** 读取 mysql 连接配置 */
function loadMysqlConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf-8')); } catch (e) { /* 用默认值 */ }
  const m = cfg.mysql || {};
  return {
    host: m.host || '127.0.0.1',
    port: Number(m.port) || 3306,
    user: m.user || 'root',
    password: m.password === undefined ? '' : String(m.password),
    database: m.database || DEFAULT_DB,
    connectionLimit: Number(m.connectionLimit) || 8,
  };
}

/** 库名合法性校验（防注入，库名无法参数化） */
function safeDbName(name) {
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`非法数据库名: ${name}`);
  return name;
}

let pool = null;

/** 取连接池（懒加载） */
function getPool() {
  if (!pool) {
    const c = loadMysqlConfig();
    pool = mysql.createPool({
      host: c.host, port: c.port, user: c.user, password: c.password, database: safeDbName(c.database),
      waitForConnections: true, connectionLimit: c.connectionLimit,
      charset: 'utf8mb4_general_ci', dateStrings: true, decimalNumbers: true, multipleStatements: false,
    });
  }
  return pool;
}

/** 关闭连接池（CLI 脚本结束前调用，否则进程不退出） */
async function closePool() {
  if (pool) { await pool.end(); pool = null; }
}

/** 查询，返回行数组 */
async function query(sql, params) {
  const [rows] = await getPool().query(sql, params);
  return rows;
}

/** 执行（INSERT/UPDATE/DELETE），返回 { affectedRows, insertId } */
async function exec(sql, params) {
  const [r] = await getPool().query(sql, params);
  return r;
}

/** 在一个事务里执行 fn(conn)，异常自动回滚 */
async function transaction(fn) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const out = await fn(conn);
    await conn.commit();
    return out;
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}

/**
 * 结构升级（幂等）：老库自动补列 / 调整索引，避免手工改库。
 * 新装环境 schema.sql 已含这些列，这里只对已存在的旧库做增量修补。
 */
async function migrate(conn, dbName) {
  const colExists = async (table, col) => {
    const [r] = await conn.query(
      `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND COLUMN_NAME=?`,
      [dbName, table, col]
    );
    return r[0].n > 0;
  };
  const idxExists = async (table, idx) => {
    const [r] = await conn.query(
      `SELECT COUNT(*) AS n FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND INDEX_NAME=?`,
      [dbName, table, idx]
    );
    return r[0].n > 0;
  };
  await conn.query(`USE \`${dbName}\``);

  // invoice_order：新增「人工确认已开票」相关列
  if (!(await colExists('invoice_order', 'state_source'))) {
    await conn.query(
      "ALTER TABLE `invoice_order` ADD COLUMN `state_source` ENUM('platform','manual') NOT NULL DEFAULT 'platform' " +
      "COMMENT '开票状态来源：platform=平台刷新，manual=人工确认（商家线下已开票）' AFTER `invoice_state`"
    );
  }
  if (!(await colExists('invoice_order', 'state_note'))) {
    await conn.query(
      "ALTER TABLE `invoice_order` ADD COLUMN `state_note` VARCHAR(255) DEFAULT NULL " +
      "COMMENT '开票状态备注（人工确认时的说明）' AFTER `state_updated_at`"
    );
  }

  // send_log：由「按天一条」改为「一次一条」，以便统计催收次数与最近催收时间
  if (await idxExists('send_log', 'uk_date_login')) {
    await conn.query('ALTER TABLE `send_log` DROP INDEX `uk_date_login`');
  }
  if (!(await colExists('send_log', 'result'))) {
    await conn.query(
      "ALTER TABLE `send_log` ADD COLUMN `result` VARCHAR(16) NOT NULL DEFAULT 'ok' " +
      "COMMENT '发送结果：ok=成功，fail=失败' AFTER `seller_company`"
    );
  }
  if (!(await colExists('send_log', 'channel'))) {
    await conn.query(
      "ALTER TABLE `send_log` ADD COLUMN `channel` VARCHAR(16) NOT NULL DEFAULT 'web' " +
      "COMMENT '发送入口：web=看板，cli=命令行' AFTER `result`"
    );
  }
  // send_log：记录每次催收「当时」的待开票金额与订单号（看板点「催收次数」查看历史）
  if (!(await colExists('send_log', 'amount'))) {
    await conn.query(
      "ALTER TABLE `send_log` ADD COLUMN `amount` DECIMAL(14,2) DEFAULT NULL " +
      "COMMENT '本次催收的待开票总金额（发送当时的快照；老记录可能为空）' AFTER `channel`"
    );
  }
  if (!(await colExists('send_log', 'order_nos'))) {
    await conn.query(
      "ALTER TABLE `send_log` ADD COLUMN `order_nos` TEXT DEFAULT NULL " +
      "COMMENT '本次催收包含的订单号（多个用「；」分隔，发送当时快照）' AFTER `amount`"
    );
  }
  // send_log：失败原因摘要（result=fail 时记录，便于排查「为什么发失败」）
  if (!(await colExists('send_log', 'error'))) {
    await conn.query(
      "ALTER TABLE `send_log` ADD COLUMN `error` VARCHAR(255) DEFAULT NULL " +
      "COMMENT '失败原因摘要（result=fail 时记录，便于排查）' AFTER `order_nos`"
    );
  }
  if (!(await idxExists('send_log', 'idx_sent_at'))) {
    await conn.query('ALTER TABLE `send_log` ADD KEY `idx_sent_at` (`sent_at`)');
  }
  if (!(await idxExists('send_log', 'idx_send_date'))) {
    await conn.query('ALTER TABLE `send_log` ADD KEY `idx_send_date` (`send_date`)');
  }
  // 表注释同步（老库沿用旧注释时更新）
  const [tc] = await conn.query(
    `SELECT TABLE_COMMENT AS c FROM information_schema.TABLES
     WHERE TABLE_SCHEMA=? AND TABLE_NAME='send_log'`, [dbName]
  );
  if (tc[0] && tc[0].c !== SEND_LOG_COMMENT) {
    await conn.query(`ALTER TABLE \`send_log\` COMMENT='${SEND_LOG_COMMENT}'`);
  }

  // seller_name_mapping：新增「忽略」标记（人工确认该销方名称没有对应的 1688 商家）
  if (!(await colExists('seller_name_mapping', 'is_ignored'))) {
    await conn.query(
      "ALTER TABLE `seller_name_mapping` ADD COLUMN `is_ignored` TINYINT(1) NOT NULL DEFAULT 0 " +
      "COMMENT '是否忽略：1=该销方名称确认无对应1688商家，从待比对列表与统计中剔除（可在名称映射页恢复）' AFTER `is_confirmed`"
    );
  }
  if (!(await idxExists('seller_name_mapping', 'idx_is_ignored'))) {
    await conn.query('ALTER TABLE `seller_name_mapping` ADD KEY `idx_is_ignored` (`is_ignored`)');
  }
  // 视图重建：待比对清单需同时排除「已映射」与「已忽略」两类（老库视图定义同步）
  await conn.query(
    'CREATE OR REPLACE VIEW `v_unmatched_seller_name` AS ' +
    'SELECT i.`seller_name` AS `tax_seller_name`, COUNT(*) AS `invoice_rows`, ' +
    'SUM(i.`total_amount`) AS `invoice_amount`, MIN(i.`invoice_date`) AS `first_invoice_date`, ' +
    'MAX(i.`invoice_date`) AS `last_invoice_date`, MAX(i.`seller_tax_no`) AS `seller_tax_no`, ' +
    'MAX(i.`remark`) AS `remark` ' +
    'FROM `issued_invoice` i ' +
    'LEFT JOIN `seller_name_mapping` m ON m.`tax_seller_name` = i.`seller_name` ' +
    'AND (m.`is_ignored` = 1 OR m.`seller_company` IS NOT NULL) ' +
    'WHERE m.`id` IS NULL GROUP BY i.`seller_name`'
  );
}

/**
 * 建库 + 建表（幂等）。执行 sql/schema.sql，并做老库结构升级。
 * 需要先手工建库时也可单独用 mysql 客户端跑该文件。
 */
async function ensureSchema() {
  const c = loadMysqlConfig();
  const db = safeDbName(c.database);
  // 1) 不指定 database 连接，建库
  const root = await mysql.createConnection({
    host: c.host, port: c.port, user: c.user, password: c.password, multipleStatements: true,
  });
  try {
    await root.query(`CREATE DATABASE IF NOT EXISTS \`${db}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`);
    await root.query(`USE \`${db}\``);
    const sqlText = fs.readFileSync(path.join(ROOT, 'sql', 'schema.sql'), 'utf-8');
    // schema.sql 自带 CREATE DATABASE / USE，整体执行即可
    await root.query(sqlText);
    // 2) 老库增量升级
    await migrate(root, db);
  } finally {
    await root.end();
  }
  await closePool();
  return { host: c.host, port: c.port, database: db };
}

/** 连接自检，返回服务器版本 */
async function ping() {
  const rows = await query('SELECT VERSION() AS v');
  return rows[0] && rows[0].v;
}

module.exports = { loadMysqlConfig, getPool, closePool, query, exec, transaction, ensureSchema, ping, safeDbName };
