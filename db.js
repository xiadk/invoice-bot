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
 * 牵牛花退单同步的表结构（幂等）。
 *
 * 这 6 张表由看板本体（lib/qnh.js）写入和查询——v0.2.4 起同步链路在 Node 内完成，
 * 不再有独立的 Python 工程。保留 CREATE TABLE IF NOT EXISTS 幂等语义。
 */
async function ensureQnhSchema(q) {
  const stmts = [
    'CREATE TABLE IF NOT EXISTS `qnh_refund_order` (' +
      "  `refund_no` VARCHAR(64) NOT NULL COMMENT '退单号（主键）'," +
      "  `service_id` VARCHAR(64) DEFAULT NULL," +
      "  `qnh_tenant_id` VARCHAR(32) DEFAULT NULL COMMENT '牵牛花租户ID'," +
      "  `order_no` VARCHAR(64) DEFAULT NULL COMMENT '关联订单号'," +
      "  `serial_no` VARCHAR(64) DEFAULT NULL COMMENT '订单号（牵牛花 serialNo，展示用）'," +
      "  `channel_name` VARCHAR(64) DEFAULT NULL COMMENT '渠道'," +
      "  `channel_id` INT DEFAULT NULL," +
      "  `store_id` VARCHAR(64) DEFAULT NULL," +
      "  `store_name` VARCHAR(128) DEFAULT NULL COMMENT '门店'," +
      "  `order_status` VARCHAR(32) DEFAULT NULL COMMENT '订单状态'," +
      "  `order_status_code` INT DEFAULT NULL," +
      "  `refund_status` VARCHAR(32) DEFAULT NULL COMMENT '退单状态'," +
      "  `refund_status_code` INT DEFAULT NULL," +
      "  `refund_type` VARCHAR(64) DEFAULT NULL COMMENT '退单类型'," +
      "  `is_appeal` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否申诉单'," +
      "  `apply_source` VARCHAR(32) DEFAULT NULL COMMENT '退单发起方'," +
      "  `apply_source_code` INT DEFAULT NULL," +
      "  `apply_reason` VARCHAR(512) DEFAULT NULL COMMENT '退单原因'," +
      "  `refund_amount` DECIMAL(14,2) DEFAULT NULL COMMENT '退单金额（元）'," +
      "  `goods_amount` DECIMAL(14,2) DEFAULT NULL," +
      "  `commission` DECIMAL(14,2) DEFAULT NULL," +
      "  `return_freight` DECIMAL(14,2) DEFAULT NULL," +
      "  `return_freight_actual` DECIMAL(14,2) DEFAULT NULL," +
      "  `refund_qty` DECIMAL(14,3) DEFAULT NULL COMMENT '退款件数'," +
      "  `refund_weight` DECIMAL(14,3) DEFAULT NULL," +
      "  `apply_time` DATETIME DEFAULT NULL COMMENT '申请时间'," +
      "  `apply_ts` BIGINT DEFAULT NULL," +
      "  `update_ts` BIGINT DEFAULT NULL COMMENT '接口 updateTime（增量比对用）'," +
      "  `finish_time` DATETIME DEFAULT NULL COMMENT '退款完成时间'," +
      "  `finish_ts` BIGINT DEFAULT NULL," +
      "  `receiver_name` VARCHAR(64) DEFAULT NULL," +
      "  `receiver_phone` VARCHAR(32) DEFAULT NULL," +
      "  `receiver_address` VARCHAR(255) DEFAULT NULL COMMENT '顾客配送地址'," +
      "  `paid_time` DATETIME DEFAULT NULL COMMENT '已支付订单时间（配送日志/接口 payTime）'," +
      "  `paid_ts` BIGINT DEFAULT NULL," +
      "  `audit_time` DATETIME DEFAULT NULL," +
      "  `audit_operator` VARCHAR(64) DEFAULT NULL," +
      "  `audit_reason` VARCHAR(512) DEFAULT NULL," +
      "  `item_kinds` INT DEFAULT NULL COMMENT '商品行数'," +
      "  `detail_synced` TINYINT(1) NOT NULL DEFAULT 0," +
      "  `has_delivery_log` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否有配送日志（含接单）'," +
      "  `picked_log` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否已取货/已送达（商品离店）'," +
      "  `log_synced` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '日志是否已同步'," +
      "  `sync_batch_id` BIGINT DEFAULT NULL," +
      "  `first_seen_at` DATETIME DEFAULT NULL," +
      "  `last_seen_at` DATETIME DEFAULT NULL," +
      "  `raw_json` LONGTEXT DEFAULT NULL," +
      "  PRIMARY KEY (`refund_no`)," +
      "  KEY `idx_qro_apply` (`apply_time`)," +
      "  KEY `idx_qro_status` (`refund_status`)," +
      "  KEY `idx_qro_tenant` (`qnh_tenant_id`)," +
      "  KEY `idx_qro_delivery` (`has_delivery_log`)" +
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='牵牛花退单主表'",

    'CREATE TABLE IF NOT EXISTS `qnh_refund_item` (' +
      "  `id` BIGINT NOT NULL AUTO_INCREMENT," +
      "  `refund_no` VARCHAR(64) NOT NULL," +
      "  `qnh_tenant_id` VARCHAR(32) DEFAULT NULL," +
      "  `item_key` VARCHAR(160) NOT NULL," +
      "  `line_no` INT DEFAULT NULL," +
      "  `item_role` VARCHAR(16) NOT NULL DEFAULT 'main'," +
      "  `parent_sku` VARCHAR(64) DEFAULT NULL," +
      "  `sku` VARCHAR(64) DEFAULT NULL," +
      "  `sku_name` VARCHAR(255) DEFAULT NULL," +
      "  `upc` VARCHAR(255) DEFAULT NULL," +
      "  `spec` VARCHAR(128) DEFAULT NULL," +
      "  `unit` VARCHAR(32) DEFAULT NULL," +
      "  `weight` DECIMAL(14,3) DEFAULT NULL," +
      "  `refund_qty` DECIMAL(14,3) DEFAULT NULL," +
      "  `order_qty` DECIMAL(14,3) DEFAULT NULL," +
      "  `sale_price` DECIMAL(14,2) DEFAULT NULL," +
      "  `origin_price` DECIMAL(14,2) DEFAULT NULL," +
      "  `item_amount` DECIMAL(14,2) DEFAULT NULL," +
      "  `pic_url` VARCHAR(512) DEFAULT NULL," +
      "  `raw_json` LONGTEXT DEFAULT NULL," +
      "  PRIMARY KEY (`id`)," +
      "  UNIQUE KEY `uk_qri_refund_item` (`refund_no`,`item_key`)," +
      "  KEY `idx_qri_sku` (`sku`)," +
      "  KEY `idx_qri_tenant` (`qnh_tenant_id`)" +
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='牵牛花退单商品明细'",

    'CREATE TABLE IF NOT EXISTS `qnh_refund_log` (' +
      "  `id` BIGINT NOT NULL AUTO_INCREMENT," +
      "  `refund_no` VARCHAR(64) NOT NULL," +
      "  `order_no` VARCHAR(64) DEFAULT NULL," +
      "  `log_type` VARCHAR(16) NOT NULL DEFAULT 'order' COMMENT 'order=订单日志 delivery=配送日志'," +
      "  `operator_name` VARCHAR(64) DEFAULT NULL," +
      "  `op_time` DATETIME DEFAULT NULL," +
      "  `op_time_ms` BIGINT NOT NULL DEFAULT 0," +
      "  `content` VARCHAR(255) NOT NULL DEFAULT ''," +
      "  `note` VARCHAR(255) DEFAULT NULL," +
      "  `source` VARCHAR(32) DEFAULT NULL," +
      "  `raw_json` TEXT DEFAULT NULL," +
      "  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP," +
      "  PRIMARY KEY (`id`)," +
      "  UNIQUE KEY `uk_qrl_item` (`refund_no`,`log_type`,`op_time_ms`,`content`)," +
      "  KEY `idx_qrl_refund` (`refund_no`)," +
      "  KEY `idx_qrl_type` (`log_type`)," +
      "  KEY `idx_qrl_time` (`op_time`)" +
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='退单订单日志 / 配送日志'",

    'CREATE TABLE IF NOT EXISTS `qnh_alert_log` (' +
      "  `id` BIGINT NOT NULL AUTO_INCREMENT," +
      "  `refund_no` VARCHAR(64) NOT NULL," +
      "  `alert_type` VARCHAR(32) NOT NULL DEFAULT 'delivery_log'," +
      "  `content` VARCHAR(1024) DEFAULT NULL," +
      "  `status` VARCHAR(16) NOT NULL DEFAULT 'ok'," +
      "  `error` VARCHAR(255) DEFAULT NULL," +
      "  `sent_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP," +
      "  PRIMARY KEY (`id`)," +
      "  UNIQUE KEY `uk_qal_refund` (`refund_no`,`alert_type`)," +
      "  KEY `idx_qal_sent` (`sent_at`)" +
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='退单提醒推送记录'",

    'CREATE TABLE IF NOT EXISTS `qnh_sync_run` (' +
      "  `id` BIGINT NOT NULL AUTO_INCREMENT," +
      "  `started_at` DATETIME DEFAULT NULL," +
      "  `finished_at` DATETIME DEFAULT NULL," +
      "  `window_start` DATETIME DEFAULT NULL," +
      "  `window_end` DATETIME DEFAULT NULL," +
      "  `refunds` INT NOT NULL DEFAULT 0," +
      "  `new_refunds` INT NOT NULL DEFAULT 0," +
      "  `items` INT NOT NULL DEFAULT 0," +
      "  `failed` INT NOT NULL DEFAULT 0," +
      "  `status` VARCHAR(32) DEFAULT NULL," +
      "  `message` VARCHAR(512) DEFAULT NULL," +
      "  PRIMARY KEY (`id`)," +
      "  KEY `idx_qsr_start` (`started_at`)" +
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='牵牛花退单同步批次'",

    'CREATE TABLE IF NOT EXISTS `qnh_sync_state` (' +
      "  `key` VARCHAR(64) NOT NULL," +
      "  `value` VARCHAR(128) DEFAULT NULL," +
      "  `updated_at` DATETIME DEFAULT NULL," +
      "  PRIMARY KEY (`key`)" +
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='牵牛花退单同步状态'",

    // 实时毛利监控：订单毛利明细（数据经「本机助手」页内签名接口拉取，见 lib/qnh.js）
    'CREATE TABLE IF NOT EXISTS `qnh_profit_order` (' +
      "  `order_no` VARCHAR(64) NOT NULL COMMENT '订单号'," +
      "  `store_name` VARCHAR(128) DEFAULT NULL COMMENT '门店'," +
      "  `order_time` DATETIME DEFAULT NULL COMMENT '下单时间'," +
      "  `order_time_ms` BIGINT DEFAULT NULL," +
      "  `profit_online` DECIMAL(14,2) DEFAULT NULL COMMENT '线上毛利（元）'," +
      "  `profit_rate_online` DECIMAL(14,4) DEFAULT NULL COMMENT '线上毛利率（%，如 39.33）'," +
      "  `alerted` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否已推送过低毛利告警'," +
      "  `data_date` DATE DEFAULT NULL COMMENT '数据归属日期（拉取批次）'," +
      "  `raw_json` LONGTEXT DEFAULT NULL," +
      "  `fetched_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP," +
      "  PRIMARY KEY (`order_no`)," +
      "  KEY `idx_qpo_time` (`order_time`)," +
      "  KEY `idx_qpo_alert` (`alerted`)" +
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='订单毛利明细（实时毛利监控）'",

    // 牵牛花登录态（Cookies）。云端部署时不能落本机文件（容器目录会随重启丢失），
    // 故统一入库；登录态由「本机助手」采集后回传，服务器自己不再启动浏览器。
    'CREATE TABLE IF NOT EXISTS `qnh_session` (' +
      "  `id` INT NOT NULL AUTO_INCREMENT," +
      "  `user_id` INT NOT NULL DEFAULT 0 COMMENT '归属用户（0=所有用户共享的一份登录态）'," +
      "  `storage_state` MEDIUMTEXT COMMENT 'Playwright storageState 格式（cookies+origins）'," +
      "  `cookie_count` INT NOT NULL DEFAULT 0," +
      "  `account_name` VARCHAR(128) DEFAULT NULL," +
      "  `tenant_id` VARCHAR(64) DEFAULT NULL," +
      "  `source` VARCHAR(32) DEFAULT NULL COMMENT '采集来源：本机助手'," +
      "  `agent_ver` VARCHAR(32) DEFAULT NULL," +
      "  `earliest_expiry` DATETIME DEFAULT NULL," +
      "  `written_at` DATETIME DEFAULT NULL," +
      "  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP," +
      "  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP," +
      "  PRIMARY KEY (`id`)," +
      "  UNIQUE KEY `uk_qs_user` (`user_id`)" +
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='牵牛花登录态（入库，替代 data/qnh-state.json）'",
  ];
  for (const s of stmts) await q(s);
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

  // ── 操作日志（全局表，不做租户隔离：管理员需跨用户查看）──
  //    老库升级同样会走到这里，无需手工建表。
  if (!(await tableExists('operation_log'))) {
    await q(
      'CREATE TABLE `operation_log` (' +
      '  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,' +
      '  `user_id` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT \'操作人（app_user.id；0=匿名）\',' +
      '  `username` VARCHAR(64) NOT NULL DEFAULT \'\' COMMENT \'操作人登录账号\',' +
      '  `action` VARCHAR(32) NOT NULL COMMENT \'操作类型\',' +
      '  `content` VARCHAR(512) NOT NULL DEFAULT \'\' COMMENT \'操作内容\',' +
      '  `detail` VARCHAR(2048) DEFAULT NULL COMMENT \'结构化明细（JSON）\',' +
      '  `ip` VARCHAR(64) NOT NULL DEFAULT \'\' COMMENT \'来源 IP\',' +
      '  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT \'操作时间\',' +
      '  PRIMARY KEY (`id`),' +
      '  KEY `idx_op_log_user` (`user_id`),' +
      '  KEY `idx_op_log_username` (`username`),' +
      '  KEY `idx_op_log_action` (`action`),' +
      '  KEY `idx_op_log_created` (`created_at`)' +
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci' +
      '  COMMENT=\'操作日志（仅超级管理员可查看）\''
    );
  }

  // ── 全局配置（看板与牵牛花同步工具共用）──
  if (!(await tableExists('app_config'))) {
    await q(
      'CREATE TABLE `app_config` (' +
      '  `key` VARCHAR(64) NOT NULL COMMENT \'配置项\',' +
      '  `value` TEXT DEFAULT NULL COMMENT \'配置值\',' +
      '  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT \'更新时间\',' +
      '  PRIMARY KEY (`key`)' +
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci' +
      '  COMMENT=\'全局配置（看板与退单同步工具共用）\''
    );
  }

  // ── 账号表：退单列表权限（默认关闭，由超级管理员逐个开启）──
  if (!(await colExists('app_user', 'qnh_refund_enabled'))) {
    await q(
      'ALTER TABLE `app_user` ADD COLUMN `qnh_refund_enabled` TINYINT(1) NOT NULL DEFAULT 0 ' +
      "COMMENT '是否允许查看退单列表页（1=开启，超级管理员始终可见）'"
    );
  }

  // ── 牵牛花退单同步的表 ──
  //    v0.2.4 起由 lib/qnh.js 在同步时写入（原先由 qnh-refund-sync 写）；
  //    启动时先建好，保证「没跑过同步就先打开退单列表」时页面不会报 1146 表不存在。
  await ensureQnhSchema(q, tableExists, idxExists);

  // 老库补列：退单日志相关标记
  if (await tableExists('qnh_refund_order')) {
    for (const [col, decl] of [
      ['has_delivery_log', "TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否有配送日志（含接单）'"],
      ['picked_log', "TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否已取货/已送达（商品离店）'"],
      ['log_synced', "TINYINT(1) NOT NULL DEFAULT 0 COMMENT '日志是否已同步'"],
      ['serial_no', "VARCHAR(64) DEFAULT NULL COMMENT '订单号（牵牛花 serialNo，展示用）'"],
      ['receiver_address', "VARCHAR(255) DEFAULT NULL COMMENT '顾客配送地址'"],
      ['paid_time', "DATETIME DEFAULT NULL COMMENT '已支付订单时间（配送日志/接口 payTime）'"],
      ['paid_ts', 'BIGINT DEFAULT NULL'],
    ]) {
      if (!(await colExists('qnh_refund_order', col))) {
        await q(`ALTER TABLE \`qnh_refund_order\` ADD COLUMN \`${col}\` ${decl}`);
      }
    }
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
