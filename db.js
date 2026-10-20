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

  // ── 毛利告警（2026-10-20 新增）：规则 / 订单快照 / 告警事件 / 采集心跳 ──
  // DDL 与 sql/schema.sql 保持一致；老库缺表时自动补建，无需手工改库。
  const profitTables = [
    "CREATE TABLE IF NOT EXISTS `profit_alert_rule` (\n  `user_id`                 INT UNSIGNED  NOT NULL                COMMENT '数据归属用户ID（app_user.id）',\n  `enabled`                 TINYINT(1)    NOT NULL DEFAULT 1      COMMENT '是否启用采集（0=本机助手停止采集）',\n  `watch_url`               VARCHAR(500)  NOT NULL DEFAULT ''     COMMENT '监控页面地址（仅允许 qnh.meituan.com 域名）',\n  `poll_interval_sec`       INT           NOT NULL DEFAULT 60     COMMENT '读取 DOM 的间隔（秒）。不发请求，仅本机页面内读取',\n  `refresh_every_sec`       INT           NOT NULL DEFAULT 300    COMMENT '多少秒点一次页面自带的刷新按钮（0=不刷新）',\n  `jitter_ratio`            DECIMAL(4,2)   NOT NULL DEFAULT 0.20  COMMENT '间隔随机抖动比例（0~0.5），让节奏不像机器',\n  `threshold`               DECIMAL(14,2) NOT NULL DEFAULT 0.00   COMMENT '阈值：线上毛利小于该值即告警（默认 0=负毛利）',\n  `value_column`            VARCHAR(64)   NOT NULL DEFAULT '线上毛利' COMMENT '判定用列（按表头文字模糊匹配）',\n  `amount_column`           VARCHAR(64)   DEFAULT NULL            COMMENT '金额列（仅展示用）',\n  `status_column`           VARCHAR(64)   NOT NULL DEFAULT '订单状态' COMMENT '状态列（用于排除取消/退款）',\n  `store_column`            VARCHAR(64)   NOT NULL DEFAULT '店铺名称' COMMENT '店铺列',\n  `order_column`            VARCHAR(64)   NOT NULL DEFAULT '订单号'   COMMENT '订单号列',\n  `ignore_status`           JSON          DEFAULT NULL            COMMENT '要排除的状态数组，如 [\"已取消\",\"已退款\"]',\n  `include_stores`          JSON          DEFAULT NULL            COMMENT '只关注这些店铺（空=全部）',\n  `exclude_stores`          JSON          DEFAULT NULL            COMMENT '排除这些店铺',\n  `excludes`                JSON          DEFAULT NULL            COMMENT '关键词排除（命中店铺名/商品名/备注即跳过）',\n  `first_page_only`         TINYINT(1)    NOT NULL DEFAULT 1      COMMENT '只读第一页（最安全；0=自动翻页）',\n  `push_channel`            ENUM('wecom','none') NOT NULL DEFAULT 'wecom' COMMENT '推送渠道：wecom=企业微信机器人，none=只记录不推送',\n  `wecom_key_mode`          ENUM('builtin','custom') NOT NULL DEFAULT 'builtin' COMMENT 'builtin=用系统内置机器人，custom=用自定义 key',\n  `wecom_key`               VARCHAR(128)  DEFAULT NULL            COMMENT '自定义机器人 key（仅存库，永不回传明文）',\n  `wecom_mention`           VARCHAR(200)  DEFAULT NULL            COMMENT '@手机号，多个用逗号分隔',\n  `max_detail`              INT           NOT NULL DEFAULT 10     COMMENT '单条推送最多列出的明细条数',\n  `repeat_after_hours`      INT           NOT NULL DEFAULT 0      COMMENT '同一笔（金额未变）多少小时后再提醒；0=只提醒一次',\n  `quiet_hours`             VARCHAR(16)   DEFAULT NULL            COMMENT '免打扰时段，如 23:00-07:00（离线告警不受限）',\n  `offline_alert_min`       INT           NOT NULL DEFAULT 20     COMMENT '超过 N 分钟没收到采集心跳→推离线告警（0=关闭）',\n  `offline_alert_repeat_min` INT          NOT NULL DEFAULT 120    COMMENT '离线告警重复间隔（分钟）',\n  `updated_by`              INT           DEFAULT NULL            COMMENT '最后修改人',\n  `updated_at`              DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,\n  PRIMARY KEY (`user_id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci\n  COMMENT='美团毛利明细告警规则（每用户一行；采集在本机助手执行）';",
    "CREATE TABLE IF NOT EXISTS `profit_order_snapshot` (\n  `user_id`       INT UNSIGNED  NOT NULL                COMMENT '数据归属用户ID',\n  `order_no`      VARCHAR(64)   NOT NULL                COMMENT '订单号（平台订单编号）',\n  `store_name`    VARCHAR(255)  DEFAULT NULL            COMMENT '店铺名称',\n  `goods_title`   VARCHAR(512)  DEFAULT NULL            COMMENT '商品名称',\n  `order_status`  VARCHAR(64)   DEFAULT NULL            COMMENT '订单状态（已取消/已完成等）',\n  `gross_profit`  DECIMAL(14,2) DEFAULT NULL            COMMENT '线上毛利（元，负数为亏损）',\n  `amount`        DECIMAL(14,2) DEFAULT NULL            COMMENT '订单金额/实付（元，仅展示）',\n  `order_time`    DATETIME      DEFAULT NULL            COMMENT '下单时间（页面能取到才填）',\n  `remark`        VARCHAR(255)  DEFAULT NULL            COMMENT '备注/摘要（用于关键词排除）',\n  `first_seen_at` DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '首次采集到的时间',\n  `last_seen_at`  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '最近一次采集到的时间',\n  PRIMARY KEY (`user_id`, `order_no`),\n  KEY `idx_profit_snap_value` (`user_id`, `gross_profit`),\n  KEY `idx_profit_snap_seen`  (`user_id`, `last_seen_at`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci\n  COMMENT='美团毛利明细快照（本机助手采集上报；每单一行最新值）';",
    "CREATE TABLE IF NOT EXISTS `profit_alert_event` (\n  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,\n  `user_id`       INT UNSIGNED  NOT NULL                COMMENT '数据归属用户ID',\n  `kind`          ENUM('neg','recovered','offline','test') NOT NULL DEFAULT 'neg' COMMENT '事件类型',\n  `order_no`      VARCHAR(64)   NOT NULL DEFAULT ''     COMMENT '订单号（offline/test 为空）',\n  `fingerprint`   CHAR(40)      NOT NULL                COMMENT '去重指纹 sha1(订单号+毛利值)',\n  `store_name`    VARCHAR(255)  DEFAULT NULL            COMMENT '店铺名称（快照）',\n  `goods_title`   VARCHAR(512)  DEFAULT NULL            COMMENT '商品名称（快照）',\n  `order_status`  VARCHAR(64)   DEFAULT NULL            COMMENT '订单状态（快照）',\n  `gross_profit`  DECIMAL(14,2) DEFAULT NULL            COMMENT '告警时的线上毛利',\n  `amount`        DECIMAL(14,2) DEFAULT NULL            COMMENT '告警时的订单金额',\n  `rule_threshold` DECIMAL(14,2) DEFAULT NULL           COMMENT '判定时使用的阈值',\n  `channel`       VARCHAR(16)   NOT NULL DEFAULT 'wecom' COMMENT '推送渠道',\n  `status`        ENUM('sent','pending','failed','skipped') NOT NULL DEFAULT 'pending'\n                                                        COMMENT '推送状态：sent=已推送，pending=待推送（免打扰/未配置），failed=推送失败',\n  `alerted_at`    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '告警时间',\n  `recovered_at`  DATETIME      DEFAULT NULL            COMMENT '负毛利恢复时间（kind=neg 用）',\n  `meta`          JSON          DEFAULT NULL            COMMENT '附加信息（推送结果、离线时长等）',\n  PRIMARY KEY (`id`),\n  UNIQUE KEY `uk_profit_event_fp` (`user_id`, `fingerprint`),\n  KEY `idx_profit_event_time` (`user_id`, `alerted_at`),\n  KEY `idx_profit_event_kind` (`user_id`, `kind`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci\n  COMMENT='毛利告警事件（指纹去重 + 推送审计）';",
    "CREATE TABLE IF NOT EXISTS `profit_collect_state` (\n  `user_id`       INT UNSIGNED  NOT NULL                COMMENT '数据归属用户ID',\n  `last_report_at` DATETIME     DEFAULT NULL            COMMENT '最近一次上报时间（无论成功失败）',\n  `last_ok_at`    DATETIME      DEFAULT NULL            COMMENT '最近一次成功采集时间',\n  `ok`            TINYINT(1)    NOT NULL DEFAULT 0      COMMENT '最近一轮是否成功',\n  `rows`          INT           NOT NULL DEFAULT 0      COMMENT '页面读到的原始行数',\n  `parsed`        INT           NOT NULL DEFAULT 0      COMMENT '成功解析的订单数',\n  `page_title`    VARCHAR(200)  DEFAULT NULL            COMMENT '页面标题（判断是否停在正确页面）',\n  `page_url`      VARCHAR(500)  DEFAULT NULL            COMMENT '页面地址',\n  `error`         VARCHAR(500)  DEFAULT NULL            COMMENT '最近一次错误（未登录/选择器失效等）',\n  `agent_ver`     VARCHAR(32)   DEFAULT NULL            COMMENT '执行采集的助手版本',\n  `target`        VARCHAR(120)  DEFAULT NULL            COMMENT '本机助手自报的采集目标（店铺/账号提示）',\n  `mode`          VARCHAR(16)   DEFAULT NULL            COMMENT '采集模式：live=正式采集，dryrun=只看不推',\n  `updated_at`    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,\n  PRIMARY KEY (`user_id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci\n  COMMENT='毛利采集心跳（用于离线告警与看板状态展示）';"
  ];
  for (const ddl of profitTables) {
    try { await q(ddl); } catch (e) { console.error('[migrate] 毛利告警表创建失败:', e.message); }
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
