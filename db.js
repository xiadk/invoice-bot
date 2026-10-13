/**
 * db.js — MySQL 连接池与建库工具（server.js / import-to-db.js 共用）
 *
 * 连接参数取自（优先级从高到低）：环境变量 → config.json 的 mysql 段 → 默认值。
 *   env: MYSQL_HOST / MYSQL_PORT / MYSQL_USER / MYSQL_PASSWORD / MYSQL_DATABASE / MYSQL_CONNECTION_LIMIT
 *   config.json: { host, port, user, password, database, connectionLimit }
 * 环境变量优先是为了云部署（Docker/K8s）时不把凭据写进镜像内的文件。
 *
 * 约定：
 *   - dateStrings=true  → DATETIME 以 'YYYY-MM-DD HH:mm:ss' 字符串返回，避免时区漂移
 *   - decimalNumbers=true → DECIMAL 以 Number 返回，看板可直接做算术
 *
 * 多租户：所有业务表带 user_id，账号表为 app_user；建库时自动种子化超级管理员 admin/admin。
 */
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DEFAULT_DB = 'invoice_bot';
const SEND_LOG_COMMENT = '催收消息发送记录（一行=一次发送，看板统计催收次数与最近催收时间）';

/** 读取 mysql 连接配置（环境变量优先，便于云部署） */
function loadMysqlConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf-8')); } catch (e) { /* 用默认值 */ }
  const m = cfg.mysql || {};
  const env = process.env;
  return {
    host: env.MYSQL_HOST || m.host || '127.0.0.1',
    port: Number(env.MYSQL_PORT || m.port) || 3306,
    user: env.MYSQL_USER || m.user || 'root',
    password: (env.MYSQL_PASSWORD !== undefined && env.MYSQL_PASSWORD !== '')
      ? env.MYSQL_PASSWORD
      : (m.password === undefined ? '' : String(m.password)),
    database: env.MYSQL_DATABASE || m.database || DEFAULT_DB,
    connectionLimit: Number(env.MYSQL_CONNECTION_LIMIT || m.connectionLimit) || 8,
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
 * 结构升级（幂等）：老库自动补列 / 调整索引 / 补建多租户账号表，避免手工改库。
 * 新装环境 schema.sql 已含这些列，这里只对已存在的旧库做增量修补。
 */
async function migrate(conn, dbName) {
  const q = async (sql, params) => { const [r] = await conn.query(sql, params); return r; };
  const colExists = async (table, col) => {
    const r = await q(
      `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND COLUMN_NAME=?`,
      [dbName, table, col]
    );
    return r[0].n > 0;
  };
  const idxExists = async (table, idx) => {
    const r = await q(
      `SELECT COUNT(*) AS n FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND INDEX_NAME=?`,
      [dbName, table, idx]
    );
    return r[0].n > 0;
  };
  const tableExists = async (table) => {
    const r = await q(
      'SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?',
      [dbName, table]
    );
    return r[0].n > 0;
  };
  await q(`USE \`${dbName}\``);

  // ── 账号表（多用户 + 超级管理员） ──
  if (!(await tableExists('app_user'))) {
    await q(
      "CREATE TABLE `app_user` (" +
      "  `id` INT NOT NULL AUTO_INCREMENT COMMENT '用户ID（同时也是数据归属的 user_id）'," +
      "  `username` VARCHAR(64) NOT NULL COMMENT '登录账号（唯一）'," +
      "  `password_hash` VARCHAR(255) NOT NULL COMMENT '密码哈希（scrypt，格式 scrypt:盐:哈希）'," +
      "  `role` ENUM('admin','user') NOT NULL DEFAULT 'user' COMMENT '角色：admin=超级管理员，user=普通用户'," +
      "  `status` ENUM('active','disabled') NOT NULL DEFAULT 'active' COMMENT '账号状态'," +
      "  `company_name` VARCHAR(255) DEFAULT NULL COMMENT '开票抬头：公司名称'," +
      "  `tax_no` VARCHAR(64) DEFAULT NULL COMMENT '开票抬头：纳税人识别号'," +
      "  `email` VARCHAR(160) DEFAULT NULL COMMENT '开票抬头：收票邮箱'," +
      "  `display_name` VARCHAR(64) DEFAULT NULL COMMENT '显示名'," +
      "  `note` VARCHAR(255) DEFAULT NULL COMMENT '备注'," +
      "  `token_version` INT NOT NULL DEFAULT 1 COMMENT '会话版本：改密/禁用时 +1，旧登录态立即失效'," +
      "  `must_change_password` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否强制下次登录修改密码'," +
      "  `created_by` INT DEFAULT NULL COMMENT '创建者（管理员ID）'," +
      "  `last_login_at` DATETIME DEFAULT NULL COMMENT '最近登录时间'," +
      "  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间'," +
      "  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间'," +
      "  PRIMARY KEY (`id`)," +
      "  UNIQUE KEY `uk_app_user_username` (`username`)," +
      "  KEY `idx_app_user_role` (`role`)" +
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='账号表（多用户登录；role=admin 为超级管理员）'"
    );
  }

  // ── 各业务表补 user_id（多租户隔离键） ──
  const tenantTables = ['invoice_order', 'issued_invoice', 'seller_name_mapping', 'send_log', 'import_log'];
  for (const t of tenantTables) {
    if (!(await tableExists(t))) continue;
    if (!(await colExists(t, 'user_id'))) {
      await q(`ALTER TABLE \`${t}\` ADD COLUMN \`user_id\` INT NOT NULL DEFAULT 1
               COMMENT '数据归属用户ID（多租户隔离键，见 app_user.id）'`);
    }
    if (!(await idxExists(t, 'idx_user_id'))) {
      await q(`ALTER TABLE \`${t}\` ADD KEY \`idx_user_id\` (\`user_id\`)`);
    }
  }

  // 唯一键改造：issued_invoice 行指纹、seller_name_mapping 销方名称，都要带上 user_id
  if (await idxExists('issued_invoice', 'uk_row_hash')) {
    await q('ALTER TABLE `issued_invoice` DROP INDEX `uk_row_hash`');
  }
  if (!(await idxExists('issued_invoice', 'uk_user_row_hash'))) {
    await q('ALTER TABLE `issued_invoice` ADD UNIQUE KEY `uk_user_row_hash` (`user_id`, `row_hash`)');
  }
  if (await idxExists('seller_name_mapping', 'uk_tax_seller_name')) {
    await q('ALTER TABLE `seller_name_mapping` DROP INDEX `uk_tax_seller_name`');
  }
  if (!(await idxExists('seller_name_mapping', 'uk_user_tax_name'))) {
    await q('ALTER TABLE `seller_name_mapping` ADD UNIQUE KEY `uk_user_tax_name` (`user_id`, `tax_seller_name`)');
  }
  // 复合索引：按用户查卖家时更快
  if (!(await idxExists('send_log', 'idx_user_login'))) {
    await q('ALTER TABLE `send_log` ADD KEY `idx_user_login` (`user_id`, `seller_login`)');
  }
  if (!(await idxExists('invoice_order', 'idx_user_seller_login'))) {
    await q('ALTER TABLE `invoice_order` ADD KEY `idx_user_seller_login` (`user_id`, `seller_login`)');
  }

  // invoice_order：新增「人工确认已开票」相关列
  if (!(await colExists('invoice_order', 'state_source'))) {
    await q(
      "ALTER TABLE `invoice_order` ADD COLUMN `state_source` ENUM('platform','manual') NOT NULL DEFAULT 'platform' " +
      "COMMENT '开票状态来源：platform=平台刷新，manual=人工确认（商家线下已开票）' AFTER `invoice_state`"
    );
  }
  if (!(await colExists('invoice_order', 'state_note'))) {
    await q(
      "ALTER TABLE `invoice_order` ADD COLUMN `state_note` VARCHAR(255) DEFAULT NULL " +
      "COMMENT '开票状态备注（人工确认时的说明）' AFTER `state_updated_at`"
    );
  }

  // send_log：由「按天一条」改为「一次一条」，以便统计催收次数与最近催收时间
  if (await idxExists('send_log', 'uk_date_login')) {
    await q('ALTER TABLE `send_log` DROP INDEX `uk_date_login`');
  }
  if (!(await colExists('send_log', 'result'))) {
    await q(
      "ALTER TABLE `send_log` ADD COLUMN `result` VARCHAR(16) NOT NULL DEFAULT 'ok' " +
      "COMMENT '发送结果：ok=成功，fail=失败' AFTER `seller_company`"
    );
  }
  if (!(await colExists('send_log', 'channel'))) {
    await q(
      "ALTER TABLE `send_log` ADD COLUMN `channel` VARCHAR(16) NOT NULL DEFAULT 'web' " +
      "COMMENT '发送入口：web=看板，cli=命令行' AFTER `result`"
    );
  }
  // send_log：记录每次催收「当时」的待开票金额与订单号（看板点「催收次数」查看历史）
  if (!(await colExists('send_log', 'amount'))) {
    await q(
      "ALTER TABLE `send_log` ADD COLUMN `amount` DECIMAL(14,2) DEFAULT NULL " +
      "COMMENT '本次催收的待开票总金额（发送当时的快照；老记录可能为空）' AFTER `channel`"
    );
  }
  if (!(await colExists('send_log', 'order_nos'))) {
    await q(
      "ALTER TABLE `send_log` ADD COLUMN `order_nos` TEXT DEFAULT NULL " +
      "COMMENT '本次催收包含的订单号（多个用「；」分隔，发送当时快照）' AFTER `amount`"
    );
  }
  // send_log：失败原因摘要（result=fail 时记录，便于排查「为什么发失败」）
  if (!(await colExists('send_log', 'error'))) {
    await q(
      "ALTER TABLE `send_log` ADD COLUMN `error` VARCHAR(255) DEFAULT NULL " +
      "COMMENT '失败原因摘要（result=fail 时记录，便于排查）' AFTER `order_nos`"
    );
  }
  if (!(await idxExists('send_log', 'idx_sent_at'))) {
    await q('ALTER TABLE `send_log` ADD KEY `idx_sent_at` (`sent_at`)');
  }
  if (!(await idxExists('send_log', 'idx_send_date'))) {
    await q('ALTER TABLE `send_log` ADD KEY `idx_send_date` (`send_date`)');
  }
  // 表注释同步（老库沿用旧注释时更新）
  const [tc] = await conn.query(
    `SELECT TABLE_COMMENT AS c FROM information_schema.TABLES
     WHERE TABLE_SCHEMA=? AND TABLE_NAME='send_log'`, [dbName]
  );
  if (tc[0] && tc[0].c !== SEND_LOG_COMMENT) {
    await q(`ALTER TABLE \`send_log\` COMMENT='${SEND_LOG_COMMENT}'`);
  }

  // seller_name_mapping：新增「忽略」标记（人工确认该销方名称没有对应的 1688 商家）
  if (!(await colExists('seller_name_mapping', 'is_ignored'))) {
    await q(
      "ALTER TABLE `seller_name_mapping` ADD COLUMN `is_ignored` TINYINT(1) NOT NULL DEFAULT 0 " +
      "COMMENT '是否忽略：1=该销方名称确认无对应1688商家，从待比对列表与统计中剔除（可在名称映射页恢复）' AFTER `is_confirmed`"
    );
  }
  if (!(await idxExists('seller_name_mapping', 'idx_is_ignored'))) {
    await q('ALTER TABLE `seller_name_mapping` ADD KEY `idx_is_ignored` (`is_ignored`)');
  }
  // 视图重建：待比对清单需同时排除「已映射」与「已忽略」两类（老库视图定义同步），并按 user_id 分组
  await q(
    'CREATE OR REPLACE VIEW `v_unmatched_seller_name` AS ' +
    'SELECT i.`user_id` AS `user_id`, i.`seller_name` AS `tax_seller_name`, COUNT(*) AS `invoice_rows`, ' +
    'SUM(i.`total_amount`) AS `invoice_amount`, MIN(i.`invoice_date`) AS `first_invoice_date`, ' +
    'MAX(i.`invoice_date`) AS `last_invoice_date`, MAX(i.`seller_tax_no`) AS `seller_tax_no`, ' +
    'MAX(i.`remark`) AS `remark` ' +
    'FROM `issued_invoice` i ' +
    'LEFT JOIN `seller_name_mapping` m ON m.`user_id` = i.`user_id` AND m.`tax_seller_name` = i.`seller_name` ' +
    'AND (m.`is_ignored` = 1 OR m.`seller_company` IS NOT NULL) ' +
    'WHERE m.`id` IS NULL GROUP BY i.`user_id`, i.`seller_name`'
  );

  // agent_task（方案C 本机浏览器通道）：老库补建表 / 补列
  // 注意：这里用 tableExists/colExists 助手；早前写成 `const [atRows] = await q(...)`，
  // 而 q 已返回行数组，再解构会让 atRows[0] 恒为 undefined，导致永远只走建表分支、
  // 补列分支形同虚设（老库因此拿不到 resume_of）。
  if (!(await tableExists('agent_task'))) {
    await q(
      'CREATE TABLE IF NOT EXISTS `agent_task` (' +
      '`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,' +
      '`user_id` INT UNSIGNED NOT NULL,' +
      "`status` ENUM('queued','running','done','aborted','failed') NOT NULL DEFAULT 'queued'," +
      '`total` INT NOT NULL DEFAULT 0, `done` INT NOT NULL DEFAULT 0,' +
      '`ok` INT NOT NULL DEFAULT 0, `fail` INT NOT NULL DEFAULT 0,' +
      '`items` JSON DEFAULT NULL, `error` VARCHAR(255) DEFAULT NULL,' +
      '`resume_of` BIGINT UNSIGNED DEFAULT NULL,' +
      '`started_at` DATETIME DEFAULT NULL, `finished_at` DATETIME DEFAULT NULL,' +
      '`created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,' +
      '`updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,' +
      'PRIMARY KEY (`id`), KEY `idx_user_status` (`user_id`,`status`), KEY `idx_user_created` (`user_id`,`created_at`)) ' +
      "ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='本机浏览器通道的发送任务（方案C）'"
    );
  } else if (!(await colExists('agent_task', 'resume_of'))) {
    // 老库已有 agent_task 但缺 resume_of（断线续跑来源）
    await q('ALTER TABLE `agent_task` ADD COLUMN `resume_of` BIGINT UNSIGNED DEFAULT NULL ' +
      "COMMENT '断线续跑来源：被接续的任务 id（NULL=全新任务）'");
  }

  // login_state（1688 登录态入库）：老库补建表
  // 说明：登录态原先是文件（data/users/<id>/state-1688.json），现改为加密入库；
  //       文件→库的一次性迁移在服务启动时由 lib/state-store.js#migrateFromFiles 执行。
  if (!(await tableExists('login_state'))) {
    await q(
      'CREATE TABLE IF NOT EXISTS `login_state` (' +
      '`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,' +
      '`user_id` INT UNSIGNED NOT NULL,' +
      "`platform` VARCHAR(16) NOT NULL DEFAULT '1688'," +
      '`state_enc` MEDIUMTEXT DEFAULT NULL,' +
      '`key_id` VARCHAR(16) DEFAULT NULL,' +
      '`cookie_count` INT NOT NULL DEFAULT 0,' +
      '`origin_count` INT NOT NULL DEFAULT 0,' +
      "`status` ENUM('active','expired','invalid') NOT NULL DEFAULT 'active'," +
      "`source` ENUM('cloud_login','extension','migrated','manual') DEFAULT NULL," +
      '`saved_at` DATETIME DEFAULT NULL,' +
      '`last_used_at` DATETIME DEFAULT NULL,' +
      '`last_checked_at` DATETIME DEFAULT NULL,' +
      '`created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,' +
      '`updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,' +
      'PRIMARY KEY (`id`), UNIQUE KEY `uk_login_state_user_platform` (`user_id`,`platform`), ' +
      'KEY `idx_login_state_status` (`status`)) ' +
      "ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='1688 登录态（加密入库）'"
    );
  }

  // ── 种子化超级管理员 + 存量数据归属 ──
  await seedAdmin(conn, dbName);
}

/**
 * 首次建库时创建超级管理员 admin/admin，并把历史（单用户时期）的数据归属到该账号。
 * 幂等：已存在 admin 账号时只做数据归属校正，不重置密码。
 */
async function seedAdmin(conn, dbName) {
  const auth = require('./lib/auth');
  const q = async (sql, params) => { const [r] = await conn.query(sql, params); return r; };

  const existing = await q('SELECT id, role FROM app_user WHERE username = ?', ['admin']);
  let adminId;
  if (existing.length === 0) {
    // 读取旧 config.json 的抬头信息作为 admin 的开票抬头
    let buyer = {};
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf-8'));
      buyer = cfg.buyerInfo || {};
    } catch (e) { /* 忽略 */ }
    const r = await q(
      `INSERT INTO app_user (username, password_hash, role, status, company_name, tax_no, email, display_name, note, created_by)
       VALUES (?, ?, 'admin', 'active', ?, ?, ?, '超级管理员', '系统初始化内置账号，建议登录后立即修改密码', NULL)`,
      ['admin', auth.hashPassword('admin'), buyer.companyName || null, buyer.taxNo || null, buyer.email || null]
    );
    adminId = r.insertId;
    console.log(`[init] 已创建超级管理员账号 admin / admin（id=${adminId}）`);
  } else {
    adminId = existing[0].id;
    // 若历史数据尚未归属任何有效用户，则归到 admin
  }

  // 存量数据（user_id=1 且 admin 不是 1 时）归到 admin；否则把 user_id=1 视为 admin 自身
  for (const t of ['invoice_order', 'issued_invoice', 'seller_name_mapping', 'send_log', 'import_log']) {
    try {
      if (adminId !== 1) {
        await q(`UPDATE \`${t}\` SET user_id = ? WHERE user_id = 1`, [adminId]);
      }
    } catch (e) { /* 表可能不存在 */ }
  }
  return adminId;
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
    // schema.sql 顶部自带 CREATE DATABASE / USE，库名默认 invoice_bot；
    // 这里按实际目标库名改写，使 MYSQL_DATABASE（或 config.json 的 database）真正生效
    // （同时也保证克隆/换库/测试库场景不会误写进 invoice_bot）。
    const sqlText = fs.readFileSync(path.join(ROOT, 'sql', 'schema.sql'), 'utf-8')
      .replace(/`invoice_bot`/g, '`' + db + '`');
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
