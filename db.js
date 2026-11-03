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
      "  `user_id` INT NOT NULL DEFAULT 1 COMMENT '数据归属用户（登录了哪位用户的牵牛花就是谁的数据）'," +
      "  `refund_no` VARCHAR(64) NOT NULL COMMENT '退单号'," +
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
      "  `refund_reason` VARCHAR(512) DEFAULT NULL COMMENT '人工填写的退款原因（同步不覆盖，页面优先展示）'," +
      "  `after_sale_status` TINYINT NOT NULL DEFAULT 0 COMMENT '售后处理状态：0待处理 1已申请 2已退货 3已退款'," +
      "  `after_sale_note` VARCHAR(255) DEFAULT NULL COMMENT '售后备注'," +
      "  `after_sale_by` VARCHAR(64) DEFAULT NULL COMMENT '最后处理人'," +
      "  `after_sale_at` DATETIME DEFAULT NULL COMMENT '最后处理时间'," +
      "  `item_kinds` INT DEFAULT NULL COMMENT '商品行数'," +
      "  `detail_synced` TINYINT(1) NOT NULL DEFAULT 0," +
      "  `has_delivery_log` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否有配送日志（含接单）'," +
      "  `picked_log` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否已取货/已送达（商品离店）'," +
      "  `log_synced` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '日志是否已同步'," +
      "  `sync_batch_id` BIGINT DEFAULT NULL," +
      "  `first_seen_at` DATETIME DEFAULT NULL," +
      "  `last_seen_at` DATETIME DEFAULT NULL," +
      "  `raw_json` LONGTEXT DEFAULT NULL," +
      "  PRIMARY KEY (`user_id`,`refund_no`)," +
      "  KEY `idx_qro_apply` (`apply_time`)," +
      "  KEY `idx_qro_status` (`refund_status`)," +
      "  KEY `idx_qro_tenant` (`qnh_tenant_id`)," +
      "  KEY `idx_qro_delivery` (`has_delivery_log`)" +
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='牵牛花退单主表'",

    'CREATE TABLE IF NOT EXISTS `qnh_refund_item` (' +
      "  `user_id` INT NOT NULL DEFAULT 1 COMMENT '数据归属用户'," +
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
      "  UNIQUE KEY `uk_qri_refund_item` (`user_id`,`refund_no`,`item_key`)," +
      "  KEY `idx_qri_sku` (`sku`)," +
      "  KEY `idx_qri_tenant` (`qnh_tenant_id`)" +
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='牵牛花退单商品明细'",

    'CREATE TABLE IF NOT EXISTS `qnh_refund_log` (' +
      "  `user_id` INT NOT NULL DEFAULT 1 COMMENT '数据归属用户'," +
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
      "  UNIQUE KEY `uk_qrl_item` (`user_id`,`refund_no`,`log_type`,`op_time_ms`,`content`)," +
      "  KEY `idx_qrl_refund` (`refund_no`)," +
      "  KEY `idx_qrl_type` (`log_type`)," +
      "  KEY `idx_qrl_time` (`op_time`)" +
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='退单订单日志 / 配送日志'",

    'CREATE TABLE IF NOT EXISTS `qnh_alert_log` (' +
      "  `user_id` INT NOT NULL DEFAULT 1 COMMENT '数据归属用户（提醒发给谁自己的机器人）'," +
      "  `id` BIGINT NOT NULL AUTO_INCREMENT," +
      "  `refund_no` VARCHAR(64) NOT NULL," +
      "  `alert_type` VARCHAR(32) NOT NULL DEFAULT 'delivery_log'," +
      "  `content` VARCHAR(1024) DEFAULT NULL," +
      "  `status` VARCHAR(16) NOT NULL DEFAULT 'ok'," +
      "  `error` VARCHAR(255) DEFAULT NULL," +
      "  `sent_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP," +
      "  PRIMARY KEY (`id`)," +
      "  UNIQUE KEY `uk_qal_refund` (`user_id`,`refund_no`,`alert_type`)," +
      "  KEY `idx_qal_sent` (`sent_at`)" +
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='退单提醒推送记录'",

    'CREATE TABLE IF NOT EXISTS `qnh_sync_run` (' +
      "  `user_id` INT NOT NULL DEFAULT 1 COMMENT '该批次同步的是谁的数据'," +
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

    // 手工登记的售后（v0.2.106）：售后管理页「新增售后」写这里。
    //   和 qnh_refund_order 完全分开：那边是牵牛花同步来的平台退单，这边是人工记账
    //   （线下单、客诉、补发等没有平台退单号的情况），同步逻辑永远不会碰这张表。
    //   列表在 lib/qnh.js 的 listAfterSales 里用 UNION ALL 与平台退单合并成一页，
    //   但退单列表 / 统计 / 趋势图只读 qnh_refund_order，所以手工记录不会串到那些地方。
    'CREATE TABLE IF NOT EXISTS `qnh_after_manual` (' +
      "  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT," +
      "  `user_id` INT NOT NULL DEFAULT 1 COMMENT '数据归属用户（员工录入时是所属主体账号）'," +
      "  `sku` VARCHAR(64) NOT NULL DEFAULT '' COMMENT '商品SKU（从商品列表搜索选中）'," +
      "  `goods_name` VARCHAR(512) NOT NULL DEFAULT '' COMMENT '商品名称（选中后可手改，兼容搜不到的商品）'," +
      "  `image_url` VARCHAR(512) DEFAULT NULL COMMENT '商品主图（选中商品时带上，仅展示用）'," +
      "  `qty` INT NOT NULL DEFAULT 1 COMMENT '售后数量'," +
      "  `apply_reason` VARCHAR(512) DEFAULT NULL COMMENT '售后原因（人工填写）'," +
      "  `status` TINYINT NOT NULL DEFAULT 0 COMMENT '售后处理状态：0待处理 1已申请 2已退货 3已退款'," +
      "  `note` VARCHAR(255) DEFAULT NULL COMMENT '处理备注'," +
      "  `handled_by` VARCHAR(64) DEFAULT NULL COMMENT '最后处理人'," +
      "  `handled_at` DATETIME DEFAULT NULL COMMENT '最后处理时间'," +
      "  `created_by` VARCHAR(64) DEFAULT NULL COMMENT '录入人'," +
      "  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP," +
      "  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP," +
      "  PRIMARY KEY (`id`)," +
      "  KEY `idx_qam_user_time` (`user_id`,`created_at`)," +
      "  KEY `idx_qam_user_status` (`user_id`,`status`)," +
      "  KEY `idx_qam_sku` (`user_id`,`sku`)" +
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='手工登记的售后（售后管理页「新增售后」）'",

    // 售后凭证图片（v0.2.108）：每次状态变更必须留一张，存七牛对象 key（不含域名）。
    //   行键 row_key 与列表一致：ref:<退单号> / man:<手工售后id>；
    //   展示时由 lib/qiniu.js 的 signUrl() 现签私有空间临时链接，库里不存 URL
    //   （换域名、换空间都不用改历史数据）。
    'CREATE TABLE IF NOT EXISTS `qnh_after_attach` (' +
      "  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT," +
      "  `user_id` INT NOT NULL DEFAULT 1 COMMENT '数据归属用户（员工操作时记所属主体账号）'," +
      "  `row_key` VARCHAR(64) NOT NULL COMMENT '售后行键：ref:<退单号> / man:<手工售后id>'," +
      "  `status` TINYINT NOT NULL DEFAULT 0 COMMENT '本次变更后的处理状态：0待处理 1已申请 2已退货 3已退款'," +
      "  `object_key` VARCHAR(512) NOT NULL COMMENT '七牛对象 key（不含域名，展示时签名）'," +
      "  `mime` VARCHAR(64) DEFAULT NULL COMMENT '图片类型（image/png 等）'," +
      "  `size` INT UNSIGNED DEFAULT NULL COMMENT '图片字节数'," +
      "  `note` VARCHAR(255) DEFAULT NULL COMMENT '本次变更的备注（冗余一份，附件单独看也能读到）'," +
      "  `created_by` VARCHAR(64) DEFAULT NULL COMMENT '操作人'," +
      "  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP," +
      "  PRIMARY KEY (`id`)," +
      "  KEY `idx_qaa_row` (`user_id`,`row_key`,`created_at`)," +
      "  KEY `idx_qaa_time` (`user_id`,`created_at`)" +
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='售后凭证图片（每次状态变更一张，存七牛 key）'",

    // 实时毛利监控：订单毛利明细（数据经「本机助手」页内签名接口拉取，见 lib/qnh.js）
    'CREATE TABLE IF NOT EXISTS `qnh_profit_order` (' +
      "  `user_id` INT NOT NULL DEFAULT 1 COMMENT '数据归属用户'," +
      "  `order_no` VARCHAR(64) NOT NULL COMMENT '订单号'," +
      "  `order_seq` VARCHAR(32) DEFAULT NULL COMMENT '订单编号/序号（页面 order_seq）'," +
      "  `channel_name` VARCHAR(64) DEFAULT NULL COMMENT '渠道名称（美团闪购等）'," +
      "  `store_name` VARCHAR(128) DEFAULT NULL COMMENT '门店'," +
      "  `order_time` DATETIME DEFAULT NULL COMMENT '下单时间'," +
      "  `order_time_ms` BIGINT DEFAULT NULL," +
      "  `profit_online` DECIMAL(14,2) DEFAULT NULL COMMENT '线上毛利（元）'," +
      "  `profit_rate_online` DECIMAL(14,4) DEFAULT NULL COMMENT '线上毛利率（%，如 39.33）'," +
      "  `est_income_amt` DECIMAL(14,2) DEFAULT NULL COMMENT '预计收入（元，页面 ord_est_income_amt）'," +
      "  `alerted` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否已推送过低毛利告警'," +
      "  `data_date` DATE DEFAULT NULL COMMENT '数据归属日期（拉取批次）'," +
      "  `raw_json` LONGTEXT DEFAULT NULL," +
      "  `fetched_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP," +
      "  PRIMARY KEY (`user_id`,`order_no`)," +
      "  KEY `idx_qpo_time` (`order_time`)," +
      "  KEY `idx_qpo_alert` (`alerted`)" +
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='订单毛利明细（实时毛利监控）'",

    // ── 拼多多：已完成订单 / 发票申请 ────────────────────────────────
    // 数据来源两个接口（都不需要风控签名，服务器可直连）：
    //   · 待申请订单 list_invoice_order   → invoice_status = 7
    //   · 已申请发票 list_invoice         → invoice_status = 0/1/2/6
    // 状态语义（实测）：7待申请 0暂不可开票（如全额退款）1开票中 2已开票 6商家处理中
    // 登录态（Cookie）由「本机助手」采集回传，存数据库不落文件（容器重启不丢）。
    'CREATE TABLE IF NOT EXISTS `pdd_order` (' +
      "  `user_id` INT NOT NULL DEFAULT 1 COMMENT '数据归属用户'," +
      "  `order_sn` VARCHAR(64) NOT NULL COMMENT '订单号'," +
      "  `mall_id` BIGINT DEFAULT NULL COMMENT '店铺 ID'," +
      "  `goods_name` VARCHAR(255) DEFAULT NULL COMMENT '商品名'," +
      "  `spec` VARCHAR(255) DEFAULT NULL COMMENT '规格'," +
      "  `thumb_url` VARCHAR(512) DEFAULT NULL COMMENT '商品图'," +
      "  `order_time` DATETIME DEFAULT NULL COMMENT '下单时间'," +
      "  `invoice_amount` DECIMAL(14,2) DEFAULT NULL COMMENT '可开票金额'," +
      "  `invoice_status` TINYINT NOT NULL DEFAULT 0 COMMENT '开票状态 7待申请 0暂不可开票 1开票中 2已开票 6商家处理中'," +
      "  `invoice_time_str` VARCHAR(255) DEFAULT NULL COMMENT '开票进度说明（如「预计订单确认收货后10日之内开票」）'," +
      "  `reject_reason` VARCHAR(512) DEFAULT NULL COMMENT '驳回原因'," +
      "  `business_type` TINYINT DEFAULT NULL COMMENT '业务类型（页面 business_type）'," +
      "  `invoice_kind` TINYINT DEFAULT NULL COMMENT '发票类型（页面 invoice_kind）'," +
      "  `payer_name` VARCHAR(128) DEFAULT NULL COMMENT '发票抬头（付款方名称）'," +
      "  `can_reapply` TINYINT(1) DEFAULT NULL COMMENT '是否可重新申请'," +
      "  `paper_shipping_id` BIGINT DEFAULT NULL COMMENT '纸质发票物流 ID'," +
      "  `paper_tracking_number` VARCHAR(128) DEFAULT NULL COMMENT '纸质发票快递单号'," +
      "  `is_full_refund` TINYINT(1) DEFAULT NULL COMMENT '是否全额退款'," +
      "  `is_mall_close` TINYINT(1) DEFAULT NULL COMMENT '店铺是否已关闭'," +
      // ── 以下 6 列来自「订单列表」接口（order_list_v4，含待付款/待发货/待收货/已完成全部订单）──
      //     与发票接口的两列状态互不覆盖：invoice_status 只由发票接口写，订单接口只写 order_*
      "  `order_status` TINYINT DEFAULT NULL COMMENT '平台订单状态：0待付款 1待发货 2待收货 3待确认收货 4已完成 5已取消 6已退款（多多买菜组合单为空）'," +
      "  `order_status_text` VARCHAR(32) DEFAULT NULL COMMENT '订单状态文案（接口 order_status_prompt，如「已签收，待确认收货」）'," +
      "  `pay_amount` DECIMAL(14,2) DEFAULT NULL COMMENT '订单实付金额（元）'," +
      "  `tabs_belong` VARCHAR(64) DEFAULT NULL COMMENT '平台分类标签 all/unreceived/unrated 等，逗号分隔'," +
      "  `parent_order_sn` VARCHAR(64) DEFAULT NULL COMMENT '组合单父单号（多多买菜 PO- 开头；自身为父单时留空）'," +
      "  `order_source` TINYINT NOT NULL DEFAULT 1 COMMENT '来源：1=发票助手接口 2=订单列表接口'," +
      "  `raw_json` LONGTEXT DEFAULT NULL," +
      "  `synced_at` DATETIME DEFAULT NULL COMMENT '本轮同步时间'," +
      "  `fetched_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP," +
      "  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP," +
      "  PRIMARY KEY (`user_id`,`order_sn`)," +
      "  KEY `idx_pdo_status` (`user_id`,`invoice_status`)," +
      "  KEY `idx_pdo_ostatus` (`user_id`,`order_status`)," +
      "  KEY `idx_pdo_time` (`order_time`)" +
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='拼多多订单与开票状态'",

    // 拼多多登录态（Cookie 串）。与 qnh_session 同样的思路：入库不落盘。
    // 只需要 Cookie 头，不需要 Playwright storageState（接口是纯 HTTP 调用）。
    'CREATE TABLE IF NOT EXISTS `pdd_session` (' +
      "  `user_id` INT NOT NULL COMMENT '归属用户（每位登录过拼多多的用户一行）'," +
      "  `cookie` MEDIUMTEXT COMMENT 'Cookie 请求头原串'," +
      "  `pdduid` VARCHAR(32) DEFAULT NULL COMMENT '拼多多用户 ID（Cookie 里的 pdd_user_id）'," +
      "  `account_name` VARCHAR(128) DEFAULT NULL COMMENT '账号昵称/手机号（若页面能取到）'," +
      "  `cookie_count` INT NOT NULL DEFAULT 0," +
      "  `source` VARCHAR(32) DEFAULT NULL COMMENT '采集来源：本机助手'," +
      "  `agent_ver` VARCHAR(32) DEFAULT NULL," +
      "  `written_at` DATETIME DEFAULT NULL," +
      "  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP," +
      "  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP," +
      "  PRIMARY KEY (`user_id`)" +
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='拼多多登录态（入库，替代本机文件）'",

    // 拼多多开票申请日志（每单一条）。申请是真实写操作（页面会真的提交开票申请），
    // 必须落库留痕：成功与否、失败原因、助手回传的接口响应摘要。
    'CREATE TABLE IF NOT EXISTS `pdd_apply_log` (' +
      "  `id` INT NOT NULL AUTO_INCREMENT," +
      "  `user_id` INT NOT NULL COMMENT '归属用户（app_user.id）'," +
      "  `order_sn` VARCHAR(64) NOT NULL COMMENT '拼多多订单号'," +
      "  `ok` TINYINT NOT NULL DEFAULT 0 COMMENT '是否提交成功 1是 0否'," +
      "  `detail` VARCHAR(255) DEFAULT NULL COMMENT '结果说明（成功/失败原因）'," +
      "  `resp` VARCHAR(500) DEFAULT NULL COMMENT '助手回传的接口响应摘要'," +
      "  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP," +
      "  PRIMARY KEY (`id`)," +
      "  KEY `idx_pal_user_sn` (`user_id`,`order_sn`)" +
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='拼多多开票申请日志'",

    // 拼多多催收消息发送日志（每单一条）。发消息也是真实外发动作（商家真的会收到），
    // 必须落库留痕：发没发出去、失败原因、发的内容、接口响应摘要。
    'CREATE TABLE IF NOT EXISTS `pdd_msg_log` (' +
      "  `id` INT NOT NULL AUTO_INCREMENT," +
      "  `user_id` INT NOT NULL COMMENT '归属用户（app_user.id）'," +
      "  `order_sn` VARCHAR(64) NOT NULL COMMENT '拼多多订单号'," +
      "  `ok` TINYINT NOT NULL DEFAULT 0 COMMENT '是否发送成功 1是 0否'," +
      "  `detail` VARCHAR(255) DEFAULT NULL COMMENT '结果说明（成功/失败原因）'," +
      "  `content` VARCHAR(500) DEFAULT NULL COMMENT '实际发送的消息内容'," +
      "  `resp` VARCHAR(500) DEFAULT NULL COMMENT '助手回传的接口响应摘要'," +
      "  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP," +
      "  PRIMARY KEY (`id`)," +
      "  KEY `idx_pml_user_sn` (`user_id`,`order_sn`)" +
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='拼多多催收消息发送日志'",

    // ── 闪电帮帮（美团 shandiancang）：可申请开票 / 已申请开票 两档订单 ────
    // ⚠ 与拼多多最大的不同：该站点有 WAF 风控（mtgsig 签名），服务器直连会被 403。
    //   请求必须发生在本机助手的真实浏览器里（页面上下文 fetch 会被风控 SDK 自动补签名），
    //   所以这里只存结果，取数链路在 electron/agent/sdc.js。
    // 数据来源两个端点（浏览器页内 fetch，参与者都是用户自己的登录态）：
    //   · 可申请开票 stage=1 → /sdc-gw1/mallApi/invoiceTitle/queryInvoiceOrderPage
    //   · 已申请开票 stage=2 → /sdc-gw1/mallApi/orderInvoice/queryOrderInvoiceForBuyer
    // 同一订单在这两档之间会迁移（申请后从 1 变 2），故主键只留订单号，stage 每次覆盖。
    'CREATE TABLE IF NOT EXISTS `sdc_order` (' +
      "  `user_id` INT NOT NULL DEFAULT 1 COMMENT '数据归属用户'," +
      "  `order_sn` VARCHAR(64) NOT NULL COMMENT '订单号'," +
      "  `stage` TINYINT NOT NULL DEFAULT 1 COMMENT '所在档位：1=可申请开票 2=已申请开票'," +
      "  `shop_id` VARCHAR(32) DEFAULT NULL COMMENT '店铺 ID（发消息用 im/shop/pub/select 换会话）'," +
      "  `shop_name` VARCHAR(128) DEFAULT NULL COMMENT '店铺名称（卖家/供应商）'," +
      "  `wm_poi_id` VARCHAR(64) DEFAULT NULL COMMENT '闪购门店 ID'," +
      "  `wm_poi_name` VARCHAR(128) DEFAULT NULL COMMENT '闪购门店名称'," +
      "  `invoice_apply_status` INT DEFAULT NULL COMMENT '开票申请状态（0未申请 1已申请；沿用平台取值）'," +
      "  `invoice_apply_desc` VARCHAR(32) DEFAULT NULL COMMENT '开票申请状态文案'," +
      "  `invoice_title` VARCHAR(200) DEFAULT NULL COMMENT '发票抬头'," +
      "  `taxpayer_ident` VARCHAR(64) DEFAULT NULL COMMENT '纳税人识别号'," +
      "  `taker_email` VARCHAR(128) DEFAULT NULL COMMENT '收票邮箱'," +
      "  `invoice_type_desc` VARCHAR(32) DEFAULT NULL COMMENT '发票类型文案（电子普通发票等）'," +
      "  `batch_no` VARCHAR(64) DEFAULT NULL COMMENT '开票申请批次号（已申请才有）'," +
      "  `total_amount` DECIMAL(14,2) DEFAULT NULL COMMENT '订单总额（元）'," +
      "  `payable_amount` DECIMAL(14,2) DEFAULT NULL COMMENT '可开票金额（元）'," +
      "  `actual_pay_amount` DECIMAL(14,2) DEFAULT NULL COMMENT '实付金额（元）'," +
      "  `after_total_amount` DECIMAL(14,2) DEFAULT NULL COMMENT '售后金额（元）'," +
      "  `order_time` DATETIME DEFAULT NULL COMMENT '下单时间'," +
      "  `pay_time` DATETIME DEFAULT NULL COMMENT '支付时间'," +
      "  `finish_time` DATETIME DEFAULT NULL COMMENT '完成时间'," +
      "  `apply_time` DATETIME DEFAULT NULL COMMENT '提交开票申请时间'," +
      "  `trade_status_desc` VARCHAR(32) DEFAULT NULL COMMENT '交易状态文案（已完成等）'," +
      "  `refund_status_desc` VARCHAR(32) DEFAULT NULL COMMENT '售后状态文案'," +
      "  `item_count` INT DEFAULT NULL COMMENT '商品条目数'," +
      "  `item_names` VARCHAR(500) DEFAULT NULL COMMENT '商品名摘要（展示用，不入 raw）'," +
      "  `invoice_time` DATETIME DEFAULT NULL COMMENT '开票时间（已申请接口按开票时间增量刷新用）'," +
      "  `online_blocked` TINYINT NOT NULL DEFAULT 0 COMMENT '平台限制线上开票（1=只能线下开票，催收按此走）'," +
      "  `raw_json` TEXT COMMENT '平台原始行 JSON（接口改版/字段口径校准的兜底证据，不参与展示）'," +
      "  `row_hash` VARCHAR(64) DEFAULT NULL COMMENT '关键字段指纹：没变就跳过更新（幂等重跑）'," +
      "  `send_count` INT NOT NULL DEFAULT 0 COMMENT '已向该店铺发过催收的次数（按店铺累计，见 sdc_msg_log）'," +
      "  `last_sent_at` DATETIME DEFAULT NULL COMMENT '最近一次催收时间'," +
      "  `synced_at` DATETIME DEFAULT NULL COMMENT '本轮同步时间'," +
      "  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP," +
      "  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP," +
      "  PRIMARY KEY (`user_id`,`order_sn`)," +
      "  KEY `idx_sdo_stage` (`user_id`,`stage`)," +
      "  KEY `idx_sdo_shop` (`user_id`,`shop_id`)," +
      "  KEY `idx_sdo_time` (`pay_time`)," +
      "  KEY `idx_sdo_invtime` (`user_id`,`invoice_time`)" +
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='闪电帮帮订单与开票申请状态'",

    // 用户自己的开票抬头（一人多条，催收前选一条）。app_user 里的 company_name/tax_no/email
    // 保留为「默认抬头」的兼容字段，新表是唯一可维护入口。
    'CREATE TABLE IF NOT EXISTS `app_invoice_title` (' +
      "  `id` INT NOT NULL AUTO_INCREMENT," +
      "  `user_id` INT NOT NULL COMMENT '归属用户（app_user.id）'," +
      "  `title` VARCHAR(200) NOT NULL COMMENT '发票抬头（公司名称）'," +
      "  `tax_no` VARCHAR(64) DEFAULT NULL COMMENT '纳税人识别号'," +
      "  `email` VARCHAR(160) DEFAULT NULL COMMENT '收票邮箱'," +
      "  `is_default` TINYINT NOT NULL DEFAULT 0 COMMENT '是否默认抬头（每用户最多一条为 1）'," +
      "  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP," +
      "  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP," +
      "  PRIMARY KEY (`id`)," +
      "  UNIQUE KEY `uk_ait_user_title` (`user_id`,`title`)," +
      "  KEY `idx_ait_user` (`user_id`)" +
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户开票抬头（催收消息里的 {companyName}/{taxNo}/{email}）'",

    // 闪电帮帮登录态记录。这里**不存 Cookie** —— 拉取与发送都在本机助手的浏览器分区里完成，
    // 服务器拿不到也不需要 Cookie；只记录「有没有登录 / 是哪个账号 / 最后同步时间」。
    'CREATE TABLE IF NOT EXISTS `sdc_session` (' +
      "  `user_id` INT NOT NULL DEFAULT 0 COMMENT '归属用户（每位登录过闪电帮帮的用户一行）'," +
      "  `sub_user_id` VARCHAR(32) DEFAULT NULL COMMENT '闪电帮帮用户 ID（登录接口 getLoginInfo 返回的 userId）'," +
      "  `account_name` VARCHAR(128) DEFAULT NULL COMMENT '账号名（如 SGzs1234567）'," +
      "  `last_sync_at` DATETIME DEFAULT NULL COMMENT '最近一次成功拉取订单数据的时间'," +
      "  `source` VARCHAR(32) DEFAULT NULL COMMENT '采集来源：本机助手'," +
      "  `agent_ver` VARCHAR(32) DEFAULT NULL COMMENT '采集时助手版本'," +
      "  `written_at` DATETIME DEFAULT NULL," +
      "  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP," +
      "  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP," +
      "  PRIMARY KEY (`user_id`)," +
      "  UNIQUE KEY `uk_ss_user` (`user_id`)" +
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='闪电帮帮登录态台账（登录发生在本机助手）'",

    // 闪电帮帮催收消息发送日志（按店铺一条）。发消息是真实对外打扰，必须留痕。
    'CREATE TABLE IF NOT EXISTS `sdc_msg_log` (' +
      "  `id` INT NOT NULL AUTO_INCREMENT," +
      "  `user_id` INT NOT NULL COMMENT '归属用户（app_user.id）'," +
      "  `shop_id` VARCHAR(32) DEFAULT NULL COMMENT '店铺 ID'," +
      "  `shop_name` VARCHAR(128) DEFAULT NULL COMMENT '店铺名称'," +
      "  `order_sns` TEXT COMMENT '本次催收包含的订单号（逗号分隔）'," +
      "  `order_count` INT NOT NULL DEFAULT 0 COMMENT '本次催收包含的订单数'," +
      "  `amount` DECIMAL(14,2) DEFAULT NULL COMMENT '本次催收的待开票总金额（元）'," +
      "  `ok` TINYINT NOT NULL DEFAULT 0 COMMENT '是否发送成功 1是 0否'," +
      "  `detail` VARCHAR(255) DEFAULT NULL COMMENT '结果说明（成功/失败原因）'," +
      "  `content` VARCHAR(1000) DEFAULT NULL COMMENT '实际发送的消息内容（多条用 ␟ 分隔）'," +
      "  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP," +
      "  PRIMARY KEY (`id`)," +
      "  KEY `idx_sml_user_shop` (`user_id`,`shop_id`)" +
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='闪电帮帮催收消息发送日志'",

    // 牵牛花登录态（Cookies）。云端部署时不能落本机文件（容器目录会随重启丢失），
    // 故统一入库；登录态由「本机助手」采集后回传，服务器自己不再启动浏览器。
    'CREATE TABLE IF NOT EXISTS `qnh_session` (' +
      "  `id` INT NOT NULL AUTO_INCREMENT," +
      "  `user_id` INT NOT NULL DEFAULT 0 COMMENT '归属用户（每位登录过牵牛花的用户一行）'," +
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

    // 每用户自己的牵牛花配置（提醒机器人 / 告警阈值 / 门店渠道参数等）。
    // 全局项（定时同步时间等）仍存 app_config；这里只放「跟着用户走」的键。
    'CREATE TABLE IF NOT EXISTS `qnh_user_config` (' +
      "  `user_id` INT NOT NULL COMMENT '归属用户（app_user.id）'," +
      "  `key` VARCHAR(64) NOT NULL," +
      "  `value` TEXT DEFAULT NULL," +
      "  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP," +
      "  PRIMARY KEY (`user_id`,`key`)" +
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='牵牛花按用户配置（提醒/告警/拉取参数）'",

    // ── 账单（按月统计收支）─────────────────────────────────────────────
    // 一人一月一行：手工项存这里；1688/拼多多两项不落库，每次由 invoice_order / pdd_order 实时聚合。
    // 收入 = 美团 + 淘宝 + 京东（全部手工）；支出 = 1688(自动) + 拼多多(自动) + 下列 12 项手工。
    'CREATE TABLE IF NOT EXISTS `billing_month` (' +
      "  `user_id` INT NOT NULL DEFAULT 1 COMMENT '数据归属用户（app_user.id）'," +
      "  `month` CHAR(7) NOT NULL COMMENT '账期月份 YYYY-MM'," +
      "  `income_meituan` DECIMAL(14,2) NOT NULL DEFAULT 0 COMMENT '收入：美团预计收入（手工）'," +
      "  `income_taobao` DECIMAL(14,2) NOT NULL DEFAULT 0 COMMENT '收入：淘宝预计收入（手工）'," +
      "  `income_jd` DECIMAL(14,2) NOT NULL DEFAULT 0 COMMENT '收入：京东预计收入（手工）'," +
      "  `exp_rent` DECIMAL(14,2) NOT NULL DEFAULT 0 COMMENT '支出：房租（手工）'," +
      "  `exp_utility` DECIMAL(14,2) NOT NULL DEFAULT 0 COMMENT '支出：水电（手工）'," +
      "  `exp_labor` DECIMAL(14,2) NOT NULL DEFAULT 0 COMMENT '支出：人工（手工）'," +
      "  `exp_warehouse` DECIMAL(14,2) NOT NULL DEFAULT 0 COMMENT '支出：中心仓（手工）'," +
      "  `exp_delivery` DECIMAL(14,2) NOT NULL DEFAULT 0 COMMENT '支出：配送费（手工）'," +
      "  `exp_promo` DECIMAL(14,2) NOT NULL DEFAULT 0 COMMENT '支出：推广费（手工）'," +
      "  `exp_liquor` DECIMAL(14,2) NOT NULL DEFAULT 0 COMMENT '支出：自采酒水（手工）'," +
      "  `exp_ice` DECIMAL(14,2) NOT NULL DEFAULT 0 COMMENT '支出：雪糕（手工）'," +
      "  `exp_produce` DECIMAL(14,2) NOT NULL DEFAULT 0 COMMENT '支出：果蔬（手工）'," +
      "  `exp_vat` DECIMAL(14,2) NOT NULL DEFAULT 0 COMMENT '支出：增值税（手工）'," +
      "  `exp_cit` DECIMAL(14,2) NOT NULL DEFAULT 0 COMMENT '支出：企业所得税（手工）'," +
      "  `exp_other` DECIMAL(14,2) NOT NULL DEFAULT 0 COMMENT '支出：其它（手工）'," +
      "  `note` VARCHAR(255) DEFAULT NULL COMMENT '备注'," +
      "  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP," +
      "  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP," +
      "  PRIMARY KEY (`user_id`,`month`)" +
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='账单（按月收支；1688/拼多多金额实时统计不落库）'",
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

  // ── 账号表：菜单权限（默认关闭，由超级管理员逐个开启；admin 恒为真）──
  if (!(await colExists('app_user', 'qnh_refund_enabled'))) {
    await q(
      'ALTER TABLE `app_user` ADD COLUMN `qnh_refund_enabled` TINYINT(1) NOT NULL DEFAULT 0 ' +
      "COMMENT '是否允许查看退单列表页（1=开启，超级管理员始终可见）'"
    );
  }
  if (!(await colExists('app_user', 'qnh_profit_enabled'))) {
    await q(
      'ALTER TABLE `app_user` ADD COLUMN `qnh_profit_enabled` TINYINT(1) NOT NULL DEFAULT 0 ' +
      "COMMENT '是否允许查看实时毛利监控（1=开启，超级管理员始终可见）'"
    );
  }
  if (!(await colExists('app_user', 'pdd_enabled'))) {
    await q(
      'ALTER TABLE `app_user` ADD COLUMN `pdd_enabled` TINYINT(1) NOT NULL DEFAULT 0 ' +
      "COMMENT '是否允许查看拼多多发票页（1=开启，超级管理员始终可见）'"
    );
  }
  // ── 商品列表 / 交易市场菜单权限（v0.2.38）：默认 0 = 所有用户默认不授权，由超管逐个开启
  if (!(await colExists('app_user', 'product_enabled'))) {
    await q(
      'ALTER TABLE `app_user` ADD COLUMN `product_enabled` TINYINT(1) NOT NULL DEFAULT 0 ' +
      "COMMENT '是否允许查看商品列表页（含补货/齐货通；1=开启，超级管理员始终可见）'"
    );
  }
  if (!(await colExists('app_user', 'market_enabled'))) {
    await q(
      'ALTER TABLE `app_user` ADD COLUMN `market_enabled` TINYINT(1) NOT NULL DEFAULT 0 ' +
      "COMMENT '是否允许查看交易市场页（1=开启，超级管理员始终可见）'"
    );
  }
  // ── 账单菜单权限（v0.2.39）：默认 0 = 所有用户默认不授权，由超管逐个开启
  if (!(await colExists('app_user', 'billing_enabled'))) {
    await q(
      'ALTER TABLE `app_user` ADD COLUMN `billing_enabled` TINYINT(1) NOT NULL DEFAULT 0 ' +
      "COMMENT '是否允许查看账单页（1=开启，超级管理员始终可见）'"
    );
  }
  // ── 补货菜单权限（v0.2.79）：默认 0 = 所有用户默认不授权，由超管逐个开启
  if (!(await colExists('app_user', 'replenish_enabled'))) {
    await q(
      'ALTER TABLE `app_user` ADD COLUMN `replenish_enabled` TINYINT(1) NOT NULL DEFAULT 0 ' +
      "COMMENT '是否允许查看补货页（含导入补货参考文件、齐货通/阿发取价加购；1=开启，超级管理员始终可见）'"
    );
  }
  // ── 平台取价权限（v0.2.95）：齐货通登录/重新取价、阿发 Token/自动匹配/阿发取价、选购加购
  //    默认 0 = 非超管一律不可见（这些操作要动平台真实账号，必须由超管逐个授权）
  if (!(await colExists('app_user', 'price_enabled'))) {
    await q(
      'ALTER TABLE `app_user` ADD COLUMN `price_enabled` TINYINT(1) NOT NULL DEFAULT 0 ' +
      "COMMENT '是否允许平台取价操作（齐货通登录/重新取价、阿发Token/自动匹配/取价、选购加购；1=开启，超级管理员始终可见）'"
    );
  }
  // ── 使用期限（v0.2.97）：新建用户默认 1 个月，到期后禁止登录、任何接口都不放行
  //    NULL = 永久有效。存量账号升级时一律为 NULL（永久），避免上线瞬间把现有客户踢下线。
  if (!(await colExists('app_user', 'expires_at'))) {
    await q(
      "ALTER TABLE `app_user` ADD COLUMN `expires_at` DATETIME NULL DEFAULT NULL " +
      "COMMENT '使用到期时间（NULL=永久有效；超过后禁止登录与所有接口）' AFTER `status`"
    );
  }
  // ── 账单新增支出项「中心仓」（v0.2.43）：排在「人工」之后，手工录入，计入支出合计
  if (await tableExists('billing_month') && !(await colExists('billing_month', 'exp_warehouse'))) {
    await q(
      "ALTER TABLE `billing_month` ADD COLUMN `exp_warehouse` DECIMAL(14,2) NOT NULL DEFAULT 0 " +
      "COMMENT '支出：中心仓（手工）'"
    );
  }

  // ── 齐货通登录态（v0.2.31）：用户在「商品列表 / 补货」页粘贴自己的 x-token 与 x-user（手机号）
  //    接口要求登录态，缺了会返回 503「商城安全参数暂时不可用」
  if (!(await colExists('app_user', 'qht_token'))) {
    await q(
      "ALTER TABLE `app_user` ADD COLUMN `qht_token` VARCHAR(128) DEFAULT NULL " +
      "COMMENT '齐货通接口登录态 x-token（用户自行粘贴，过期需重贴）'"
    );
  }
  if (!(await colExists('app_user', 'qht_x_user'))) {
    await q(
      "ALTER TABLE `app_user` ADD COLUMN `qht_x_user` VARCHAR(64) DEFAULT NULL " +
      "COMMENT '齐货通接口登录态 x-user（一般是登录手机号）'"
    );
  }

  // ── 阿发（城配速达）登录态（v0.2.78）：用户粘贴城配速达小程序的 authorization（JWT）及其门店/小程序参数
  //    本项目只做「Token 配置」不做「登录/解绑」：小程序无退出按钮，过期后重新粘贴即可
  if (!(await colExists('app_user', 'afa_token'))) {
    await q(
      "ALTER TABLE `app_user` ADD COLUMN `afa_token` VARCHAR(1024) DEFAULT NULL " +
      "COMMENT '城配速达接口鉴权 JWT（Bearer 内容，用户自行粘贴，过期需重贴）'"
    );
  }
  if (!(await colExists('app_user', 'afa_store_id'))) {
    await q(
      "ALTER TABLE `app_user` ADD COLUMN `afa_store_id` VARCHAR(32) DEFAULT NULL " +
      "COMMENT '城配速达门店ID（JWT 内不含 mid，storeId 需用户配置）'"
    );
  }
  if (!(await colExists('app_user', 'afa_app_id'))) {
    await q(
      "ALTER TABLE `app_user` ADD COLUMN `afa_app_id` VARCHAR(64) DEFAULT NULL " +
      "COMMENT '城配速达小程序 appId（默认 wxc050ff76c31c4371）'"
    );
  }

  // ── 商品列表补列（v0.2.31）：补货界面要的建议量 / 齐货通商品ID / 本地价 ──
  if (await tableExists('product_item')) {
    for (const [col, decl] of [
      ['suggest_qty', "INT NOT NULL DEFAULT 0 COMMENT '建议量（基础单位，来自补货参考文件的「建议量(基础单位)」列）'"],
      ['qht_goods_id', "VARCHAR(64) DEFAULT NULL COMMENT '关联的齐货通商品ID（goodsId，用于实时取价与加购）'"],
      ['afa_goods_id', "VARCHAR(64) DEFAULT NULL COMMENT '关联的城配速达商品ID（goodsId，用于实时取价与加购）'"],
      ['jd_sku_id', "VARCHAR(64) DEFAULT NULL COMMENT '关联的京东万商 skuId（b.jd.com 商品ID，用于取万商价）'"],
      ['local_price', "DECIMAL(12,2) DEFAULT NULL COMMENT '本地价（手工填写并保存，仅作比价参考）'"],
      ['image_url', "VARCHAR(512) DEFAULT NULL COMMENT '商品主图（由「商品同步」从牵牛花拉取，按 sku 匹配更新）'"],
    ]) {
      if (!(await colExists('product_item', col))) {
        await q(`ALTER TABLE \`product_item\` ADD COLUMN \`${col}\` ${decl}`);
      }
    }
    // 补货导入缺列（v0.2.87）：importReplenishFile 从 v0.2.83 起就往 INSERT 里写 brand_id
    // （按「品牌 + SKU」回填主图用），但当时只改了代码没加列 → 一导入就 Unknown column 'brand_id'。
    if (!(await colExists('product_item', 'brand_id'))) {
      await q(
        "ALTER TABLE `product_item` ADD COLUMN `brand_id` INT NOT NULL DEFAULT 1 " +
        "COMMENT '导入者所属品牌方（brand.id）：仅用于按品牌商品补主图，补货数据仍按用户隔离'"
      );
      // 回填：老行按导入者当前所属品牌修正（加列时的默认值统一是 1）
      await q('UPDATE `product_item` pi JOIN `app_user` u ON u.id = pi.user_id SET pi.brand_id = u.brand_id');
    }
    if (!(await idxExists('product_item', 'idx_pi_brand'))) {
      await q('ALTER TABLE `product_item` ADD KEY `idx_pi_brand` (`brand_id`)');
    }
  }

  // ── 品牌方（v0.2.83）──────────────────────────────────────────────────────
  //   业务背景：一个代运营团队可能同时承运多个品牌方（各自有独立的牵牛花账号/门店仓），
  //   同一品牌方下的多个用户共用一套「品牌商品」数据（商品同步拉取的采购价/库存/销量等）。
  //   表关系：
  //     · brand            品牌方字典（超管可在后台新增）
  //     · app_user.brand_id 用户归属品牌方（新建用户默认「优购哆」）
  //     · brand_product    品牌级商品主数据（「商品同步」写入，品牌内全员共享，唯一键 brand_id+sku）
  //     · product_item     保持个人隔离（「导入补货参考文件」的数据仍归各自用户）
  //     · qnh_session      牵牛花登录态按品牌方隔离（每个品牌一个账号）
  if (!(await tableExists('brand'))) {
    await q(
      'CREATE TABLE `brand` (' +
      "  `id` INT NOT NULL AUTO_INCREMENT COMMENT '品牌方ID'," +
      "  `name` VARCHAR(64) NOT NULL COMMENT '品牌方名称'," +
      "  `status` ENUM('active','disabled') NOT NULL DEFAULT 'active' COMMENT '状态：active=启用，disabled=停用'," +
      "  `note` VARCHAR(255) DEFAULT NULL COMMENT '备注（如牵牛花登录账号）'," +
      "  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间'," +
      "  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间'," +
      '  PRIMARY KEY (`id`),' +
      '  UNIQUE KEY `uk_brand_name` (`name`)' +
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='品牌方字典（商品数据按品牌方共享）'"
    );
  }
  // 种子：优购哆（id=1）。INSERT IGNORE 保证重复执行不报错、也不覆盖已改过的名称。
  await q("INSERT IGNORE INTO `brand` (`id`, `name`, `note`) VALUES (1, '优购哆', '系统内置默认品牌方')");
  if (!(await colExists('app_user', 'brand_id'))) {
    await q(
      "ALTER TABLE `app_user` ADD COLUMN `brand_id` INT NOT NULL DEFAULT 1 " +
      "COMMENT '所属品牌方（brand.id，默认优购哆）'"
    );
  }
  if (!(await idxExists('app_user', 'idx_app_user_brand'))) {
    await q('ALTER TABLE `app_user` ADD KEY `idx_app_user_brand` (`brand_id`)');
  }
  // ── 员工账号（v0.2.104）───────────────────────────────────────────────────
  //   owner_id = 该账号归属的主体账号（「老板」）；NULL = 自主账号（现有账号全是 NULL）。
  //   员工登录后所有业务数据都落在 owner_id 名下（tenantOf 会把它当数据归属者），
  //   自己那一行只承载登录凭据 + 菜单开关，因此一个字段就能复用整套多租户逻辑。
  if (!(await colExists('app_user', 'owner_id'))) {
    await q(
      "ALTER TABLE `app_user` ADD COLUMN `owner_id` INT DEFAULT NULL " +
      "COMMENT '归属主体账号（员工号指向老板的 app_user.id；NULL=自主账号）' AFTER `brand_id`"
    );
  }
  if (!(await idxExists('app_user', 'idx_app_user_owner'))) {
    await q('ALTER TABLE `app_user` ADD KEY `idx_app_user_owner` (`owner_id`)');
  }
  // 售后管理菜单（v0.2.104）：默认 0，与其它菜单一样由超管逐个开启
  if (!(await colExists('app_user', 'after_sale_enabled'))) {
    await q(
      'ALTER TABLE `app_user` ADD COLUMN `after_sale_enabled` TINYINT(1) NOT NULL DEFAULT 0 ' +
      "COMMENT '是否允许查看售后管理页（1=开启，超级管理员始终可见）'"
    );
  }
  // 品牌级商品主数据：一次同步写入，同品牌下所有用户共享
  if (!(await tableExists('brand_product'))) {
    await q(
      'CREATE TABLE `brand_product` (' +
      "  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT," +
      "  `brand_id` INT NOT NULL COMMENT '品牌方（brand.id）'," +
      "  `sku` VARCHAR(64) NOT NULL COMMENT '商品SKU（= 牵牛花 goodsId，19 位长数字用文本存储）'," +
      "  `goods_name` VARCHAR(512) NOT NULL DEFAULT '' COMMENT '商品名称（goodsName）'," +
      "  `image_url` VARCHAR(512) DEFAULT NULL COMMENT '商品主图（picUrl）'," +
      "  `purchase_price` DECIMAL(12,2) NOT NULL DEFAULT 0 COMMENT '采购价（purchasePrice）'," +
      "  `available_stock` INT NOT NULL DEFAULT 0 COMMENT '可用库存（inStoreValidStockQty）'," +
      "  `transit_stock` INT NOT NULL DEFAULT 0 COMMENT '在途库存（inTransitQty）'," +
      "  `purchase_status` VARCHAR(32) NOT NULL DEFAULT '' COMMENT '采购状态（purchaseStatusDesc）'," +
      "  `purchase_status_code` TINYINT NOT NULL DEFAULT 0 COMMENT '采购状态码（接口 purchaseStatuses：1=正常采购 2=已停采）'," +
      "  `sales_30d` INT NOT NULL DEFAULT 0 COMMENT '30天销量（sale30Num）'," +
      "  `synced_at` DATETIME DEFAULT NULL COMMENT '最近一次同步时间'," +
      "  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '首次同步时间'," +
      "  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '最近更新时间'," +
      '  PRIMARY KEY (`id`),' +
      '  UNIQUE KEY `uk_bp_brand_sku` (`brand_id`, `sku`),' +
      '  KEY `idx_bp_brand_status` (`brand_id`, `purchase_status`),' +
      '  KEY `idx_bp_sku` (`sku`)' +
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='品牌商品（商品同步写入；同品牌全员共享）'"
    );
  }
  // 采购状态码（v0.2.84）：同步会分别拉「正常采购(1)」与「已停采(2)」两轮，
  // 光靠 purchaseStatusDesc 中文文案判断停采不稳，单独存状态码供统计/筛选使用。
  if (await tableExists('brand_product')) {
    if (!(await colExists('brand_product', 'purchase_status_code'))) {
      await q(
        "ALTER TABLE `brand_product` ADD COLUMN `purchase_status_code` TINYINT NOT NULL DEFAULT 0 " +
        "COMMENT '采购状态码（接口 purchaseStatuses：1=正常采购 2=已停采）'"
      );
    }
    if (!(await idxExists('brand_product', 'idx_bp_brand_scode'))) {
      await q('ALTER TABLE `brand_product` ADD KEY `idx_bp_brand_scode` (`brand_id`, `purchase_status_code`)');
    }
  }
  // ── 商品关联补列（v0.2.87）────────────────────────────────────────────────
  //   齐货通/阿发/本地价原先只存在 product_item（个人级），而「商品列表」读的是 brand_product，
  //   写接口也按 user_id+sku 更新 product_item → 商品列表里永远存不进、读不出。
  //   商品主数据本身是品牌级的，关联统一改存 brand_product（同品牌共享）；
  //   补货页 SELECT 里本来就已经 JOIN brand_product 补主图，直接顺带取这三列即可。
  if (await tableExists('brand_product')) {
    for (const [col, decl] of [
      ['qht_goods_id', "VARCHAR(64) DEFAULT NULL COMMENT '关联的齐货通商品ID（goodsId，用于实时取价与加购）'"],
      ['afa_goods_id', "VARCHAR(64) DEFAULT NULL COMMENT '关联的城配速达商品ID（goodsId，用于实时取价与加购）'"],
      ['jd_sku_id', "VARCHAR(64) DEFAULT NULL COMMENT '关联的京东万商 skuId（b.jd.com 商品ID，用于取万商价）'"],
      ['local_price', "DECIMAL(12,2) DEFAULT NULL COMMENT '本地价（手工填写，仅作比价参考）'"],
      ['afa_match_score', "SMALLINT DEFAULT NULL COMMENT '阿发自动匹配得分（0-100；手工关联留空）'"],
      ['afa_match_at', "DATETIME DEFAULT NULL COMMENT '阿发自动匹配写入时间（非空=自动匹配结果）'"],
    ]) {
      if (!(await colExists('brand_product', col))) {
        await q(`ALTER TABLE \`brand_product\` ADD COLUMN \`${col}\` ${decl}`);
      }
    }
    if (!(await idxExists('brand_product', 'idx_bp_afa'))) {
      await q('ALTER TABLE `brand_product` ADD KEY `idx_bp_afa` (`brand_id`, `afa_goods_id`)');
    }
    if (!(await idxExists('brand_product', 'idx_bp_jd'))) {
      await q('ALTER TABLE `brand_product` ADD KEY `idx_bp_jd` (`brand_id`, `jd_sku_id`)');
    }
  }
  // 牵牛花登录态按品牌方隔离：每个品牌方一个账号，老登录态归默认品牌（优购哆）
  if (await tableExists('qnh_session')) {
    if (!(await colExists('qnh_session', 'brand_id'))) {
      await q(
        "ALTER TABLE `qnh_session` ADD COLUMN `brand_id` INT NOT NULL DEFAULT 1 " +
        "COMMENT '登录态所属品牌方（brand.id）：每个品牌方一套牵牛花账号'"
      );
    }
    if (!(await idxExists('qnh_session', 'idx_qnhs_brand'))) {
      await q('ALTER TABLE `qnh_session` ADD KEY `idx_qnhs_brand` (`brand_id`)');
    }
    // 唯一键口径由「每个用户一份」改为「每个品牌一份」（同一品牌下所有用户共用该品牌的牵牛花账号）
    if (await idxExists('qnh_session', 'uk_qs_user')) {
      // 同品牌只保留最近写入的一条，避免加唯一键时冲突
      await q('DELETE s1 FROM `qnh_session` s1 JOIN `qnh_session` s2 ON s1.brand_id = s2.brand_id AND s1.id < s2.id');
      await q('ALTER TABLE `qnh_session` DROP INDEX `uk_qs_user`');
    }
    if (!(await idxExists('qnh_session', 'uk_qs_brand'))) {
      await q('ALTER TABLE `qnh_session` ADD UNIQUE KEY `uk_qs_brand` (`brand_id`)');
    }
  }

  // ── 拼多多订单补列（老库）：订单列表接口带来的平台状态 / 实付金额 / 来源 ──
  if (await tableExists('pdd_order')) {
    for (const [col, decl] of [
      ['order_status', "TINYINT DEFAULT NULL COMMENT '平台订单状态 0待付款 1待发货 2待收货 3待确认收货 4已完成 5已取消 6已退款'"],
      ['order_status_text', "VARCHAR(32) DEFAULT NULL COMMENT '订单状态文案（接口 order_status_prompt）'"],
      ['pay_amount', "DECIMAL(14,2) DEFAULT NULL COMMENT '订单实付金额（元）'"],
      ['tabs_belong', "VARCHAR(64) DEFAULT NULL COMMENT '平台分类标签 all/unreceived/unrated 等'"],
      ['parent_order_sn', "VARCHAR(64) DEFAULT NULL COMMENT '组合单父单号（多多买菜 PO-）'"],
      ['order_source', "TINYINT NOT NULL DEFAULT 1 COMMENT '来源：1=发票助手接口 2=订单列表接口'"],
    ]) {
      if (!(await colExists('pdd_order', col))) {
        await q(`ALTER TABLE \`pdd_order\` ADD COLUMN \`${col}\` ${decl}`);
      }
    }
    if (!(await idxExists('pdd_order', 'idx_pdo_ostatus'))) {
      await q('ALTER TABLE `pdd_order` ADD KEY `idx_pdo_ostatus` (`user_id`,`order_status`)');
    }
  }

  // ── 闪电帮帮订单补列（老库）：开票时间 / 限制线上开票 / 原始行 ──
  if (await tableExists('sdc_order')) {
    for (const [col, decl] of [
      ['invoice_time', "DATETIME DEFAULT NULL COMMENT '开票时间（已申请接口按开票时间增量刷新用）'"],
      ['online_blocked', "TINYINT NOT NULL DEFAULT 0 COMMENT '平台限制线上开票（1=只能线下开票）'"],
      ['raw_json', "TEXT COMMENT '平台原始行 JSON（口径校准证据）'"],
    ]) {
      if (!(await colExists('sdc_order', col))) {
        await q(`ALTER TABLE \`sdc_order\` ADD COLUMN \`${col}\` ${decl}`);
      }
    }
    if (!(await idxExists('sdc_order', 'idx_sdo_invtime'))) {
      await q('ALTER TABLE `sdc_order` ADD KEY `idx_sdo_invtime` (`user_id`,`invoice_time`)');
    }
    // 历史数据修正（幂等）：订单已关闭 = 开不出票，原来被当成「可申请开票」，
    // 既虚增待开票金额又会被算进催收范围。这里一次性归到档位 5「已关闭·无法开票」。
    // 只动 1/3 两档：2 已申请说明票在流程里、4 已开票是终态，都不该被抹掉。
    await q(
      `UPDATE \`sdc_order\` SET stage = 5
        WHERE stage IN (1, 3)
          AND IFNULL(trade_status_desc, '') IN ('已关闭', '已取消', '订单关闭')`
    );
  }

  // ── 毛利明细补列（老库）：订单编号 / 渠道名称 / 预计收入 ──
  if (await tableExists('qnh_profit_order')) {
    for (const [col, decl] of [
      ['order_seq', "VARCHAR(32) DEFAULT NULL COMMENT '订单编号/序号（页面 order_seq）'"],
      ['channel_name', "VARCHAR(64) DEFAULT NULL COMMENT '渠道名称（美团闪购等）'"],
      ['est_income_amt', "DECIMAL(14,2) DEFAULT NULL COMMENT '预计收入（元，页面 ord_est_income_amt）'"],
    ]) {
      if (!(await colExists('qnh_profit_order', col))) {
        await q(`ALTER TABLE \`qnh_profit_order\` ADD COLUMN \`${col}\` ${decl}`);
      }
    }
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
    // 售后管理 / 退款原因（v0.2.104）：两列都只由本系统写，同步只更新平台字段，不会覆盖这里
    for (const [col, decl] of [
      ['refund_reason', "VARCHAR(512) DEFAULT NULL COMMENT '人工填写的退款原因（同步不覆盖，页面优先展示）'"],
      ['after_sale_status', "TINYINT NOT NULL DEFAULT 0 COMMENT '售后处理状态：0待处理 1已申请 2已退货 3已退款'"],
      ['after_sale_note', "VARCHAR(255) DEFAULT NULL COMMENT '售后备注'"],
      ['after_sale_by', "VARCHAR(64) DEFAULT NULL COMMENT '最后处理人'"],
      ['after_sale_at', "DATETIME DEFAULT NULL COMMENT '最后处理时间'"],
    ]) {
      if (!(await colExists('qnh_refund_order', col))) {
        await q(`ALTER TABLE \`qnh_refund_order\` ADD COLUMN \`${col}\` ${decl}`);
      }
    }
    if (!(await idxExists('qnh_refund_order', 'idx_qro_after'))) {
      await q('ALTER TABLE `qnh_refund_order` ADD KEY `idx_qro_after` (`user_id`, `after_sale_status`)');
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

  // ── 牵牛花数据按用户隔离（2026-10-24）：补 user_id 列 + 重建含 user_id 的主键/唯一键 ──
  //    语义：登录了哪位用户的牵牛花，退单/毛利/告警就归谁；管理员以用户身份进入查看。
  const qnhTenantTables = [
    'qnh_refund_order', 'qnh_refund_item', 'qnh_refund_log', 'qnh_alert_log', 'qnh_sync_run', 'qnh_profit_order',
  ];
  for (const t of qnhTenantTables) {
    if (!(await tableExists(t))) continue;
    if (!(await colExists(t, 'user_id'))) {
      await q(`ALTER TABLE \`${t}\` ADD COLUMN \`user_id\` INT NOT NULL DEFAULT 1
               COMMENT '数据归属用户（登录了哪位用户的牵牛花就是谁的数据）'`);
      if (!(await idxExists(t, 'idx_user_id'))) {
        await q(`ALTER TABLE \`${t}\` ADD KEY \`idx_user_id\` (\`user_id\`)`);
      }
    }
  }
  // 重建主键/唯一键：把 user_id 纳入（老库这些键只含业务列，跨用户会撞键）
  const qnhKeyRebuilds = [
    // [表, 键名, 类型, 新列, 旧键是否为该名（PRIMARY 固定叫 PRIMARY）]
    ['qnh_refund_order', 'PRIMARY', 'PRIMARY', ['user_id', 'refund_no']],
    ['qnh_refund_item', 'uk_qri_refund_item', 'UNIQUE', ['user_id', 'refund_no', 'item_key']],
    ['qnh_refund_log', 'uk_qrl_item', 'UNIQUE', ['user_id', 'refund_no', 'log_type', 'op_time_ms', 'content']],
    ['qnh_alert_log', 'uk_qal_refund', 'UNIQUE', ['user_id', 'refund_no', 'alert_type']],
    ['qnh_profit_order', 'PRIMARY', 'PRIMARY', ['user_id', 'order_no']],
  ];
  const indexCols = async (table, name) => {
    const rows = await q(
      `SELECT COLUMN_NAME FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND INDEX_NAME=? ORDER BY SEQ_IN_INDEX`,
      [dbName, table, name]
    );
    return rows.map((r) => r.COLUMN_NAME);
  };
  // 老库上 qnh_refund_item 有外键 fk_qri_refund(refund_no) → qnh_refund_order(refund_no)；
  // 只要父表主键变了，这个 FK 就会挡住 DROP/ADD PRIMARY KEY（"needed in a foreign key constraint"）。
  // 先临时摘掉，键重建完再按新主键重建 FK（列改成 user_id + refund_no，级联删除保留）。
  const fkOnRefundOrder = async () => {
    try {
      const rows = await q(
        `SELECT CONSTRAINT_NAME, TABLE_NAME FROM information_schema.KEY_COLUMN_USAGE
         WHERE TABLE_SCHEMA=? AND REFERENCED_TABLE_NAME='qnh_refund_order'`,
        [dbName]
      );
      return rows || [];
    } catch (e) { return []; }
  };
  const droppedFks = await fkOnRefundOrder();
  for (const fk of droppedFks) {
    try {
      await q(`ALTER TABLE \`${fk.TABLE_NAME}\` DROP FOREIGN KEY \`${fk.CONSTRAINT_NAME}\``);
      console.log(`[db] 临时移除外键 ${fk.TABLE_NAME}.${fk.CONSTRAINT_NAME}（重建主键后再加回）`);
    } catch (e) {
      console.warn(`[db] 移除外键 ${fk.TABLE_NAME}.${fk.CONSTRAINT_NAME} 失败: ${e.message}`);
    }
  }
  for (const [t, keyName, keyType, cols] of qnhKeyRebuilds) {
    if (!(await tableExists(t))) continue;
    try {
      const cur = await indexCols(t, keyName);
      if (cur.length === cols.length && cur.every((c, i) => c === cols[i])) continue; // 已是新结构
      if (cur.length) await q(`ALTER TABLE \`${t}\` DROP INDEX \`${keyName}\``);
      const colSql = cols.map((c) => `\`${c}\``).join(',');
      const add = keyType === 'PRIMARY'
        ? `ADD PRIMARY KEY (${colSql})`
        : `ADD UNIQUE KEY \`${keyName}\` (${colSql})`;
      await q(`ALTER TABLE \`${t}\` ${add}`);
    } catch (e) {
      console.warn(`[db] ${t}.${keyName} 重建失败（可忽略若已手动处理）: ${e.message}`);
    }
  }
  // 外键加回：item(user_id, refund_no) → order(user_id, refund_no)，删退单时级联删明细
  if (droppedFks.length && (await tableExists('qnh_refund_item')) && (await tableExists('qnh_refund_order'))) {
    try {
      const still = await fkOnRefundOrder();
      if (!still.length) {
        await q(
          'ALTER TABLE `qnh_refund_item` ADD CONSTRAINT `fk_qri_refund` ' +
          'FOREIGN KEY (`user_id`, `refund_no`) REFERENCES `qnh_refund_order` (`user_id`, `refund_no`) ON DELETE CASCADE'
        );
        console.log('[db] 已重建外键 qnh_refund_item.fk_qri_refund（user_id + refund_no）');
      }
    } catch (e) {
      console.warn(`[db] 重建外键 fk_qri_refund 失败（可忽略，明细靠退单号自行维护）: ${e.message}`);
    }
  }


  // 唯一键改造：issued_invoice 行指纹、seller_name_mapping 销方名称，都要带上 user_id
  if (await idxExists('issued_invoice', 'uk_row_hash')) {
    await q('ALTER TABLE `issued_invoice` DROP INDEX `uk_row_hash`');
  }
  if (!(await idxExists('issued_invoice', 'uk_user_row_hash'))) {
    await q('ALTER TABLE `issued_invoice` ADD UNIQUE KEY `uk_user_row_hash` (`user_id`, `row_hash`)');
  }
  // 复合索引：按用户查卖家时更快
  if (!(await idxExists('send_log', 'idx_user_login'))) {
    await q('ALTER TABLE `send_log` ADD KEY `idx_user_login` (`user_id`, `seller_login`)');
  }
  // 税名核对页性能（v0.2.29）：按「销方名称」聚合并按最近开票时间排序、普通用户按 (用户, 销方) 过滤
  if (!(await idxExists('issued_invoice', 'idx_user_seller_name'))) {
    await q('ALTER TABLE `issued_invoice` ADD KEY `idx_user_seller_name` (`user_id`, `seller_name`)');
  }
  if (!(await idxExists('issued_invoice', 'idx_seller_invoice_date'))) {
    await q('ALTER TABLE `issued_invoice` ADD KEY `idx_seller_invoice_date` (`seller_name`, `invoice_date`)');
  }
  // 商家候选下拉按公司名搜索（原先只有 seller_login 的复合索引，按公司名过滤会全表扫）
  if (!(await idxExists('invoice_order', 'idx_user_seller_company'))) {
    await q('ALTER TABLE `invoice_order` ADD KEY `idx_user_seller_company` (`user_id`, `seller_company`)');
  }
  // 唯一键改造（v0.2.15）：seller_name_mapping 改为全员共享——tax_seller_name 全局唯一，
  // user_id 退化为「维护人」（记录这条映射最早由谁维护）。老库从 (user_id, tax_seller_name)
  // 迁移过来时先把同一销方名称的多行合并成一行。
  if (await idxExists('seller_name_mapping', 'uk_user_tax_name')) {
    const dups = await q(
      'SELECT tax_seller_name FROM seller_name_mapping GROUP BY tax_seller_name HAVING COUNT(*) > 1'
    );
    for (const d of dups) {
      const rows = await q(
        'SELECT id FROM seller_name_mapping WHERE tax_seller_name = ? ' +
        'ORDER BY seller_company IS NULL ASC, is_confirmed DESC, updated_at DESC, id ASC LIMIT 1',
        [d.tax_seller_name]
      );
      const keep = rows[0] && rows[0].id;
      if (keep != null) {
        await q('DELETE FROM seller_name_mapping WHERE tax_seller_name = ? AND id <> ?', [d.tax_seller_name, keep]);
        console.log(`[db] 税名共享化：销方「${d.tax_seller_name}」的多条映射已合并保留一条`);
      }
    }
    await q('ALTER TABLE `seller_name_mapping` DROP INDEX `uk_user_tax_name`');
  }
  if (!(await idxExists('seller_name_mapping', 'uk_tax_seller_name'))) {
    await q('ALTER TABLE `seller_name_mapping` ADD UNIQUE KEY `uk_tax_seller_name` (`tax_seller_name`)');
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
  // （映射全员共享后，JOIN 只按销方名称匹配，不再按 user_id——别的用户核过的销方也算已处理）
  await q(
    'CREATE OR REPLACE VIEW `v_unmatched_seller_name` AS ' +
    'SELECT i.`user_id` AS `user_id`, i.`seller_name` AS `tax_seller_name`, COUNT(*) AS `invoice_rows`, ' +
    'SUM(i.`total_amount`) AS `invoice_amount`, MIN(i.`invoice_date`) AS `first_invoice_date`, ' +
    'MAX(i.`invoice_date`) AS `last_invoice_date`, MAX(i.`seller_tax_no`) AS `seller_tax_no`, ' +
    'MAX(i.`remark`) AS `remark` ' +
    'FROM `issued_invoice` i ' +
    'LEFT JOIN `seller_name_mapping` m ON m.`tax_seller_name` = i.`seller_name` ' +
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
      '`title_id` INT UNSIGNED DEFAULT NULL,' +
      '`started_at` DATETIME DEFAULT NULL, `finished_at` DATETIME DEFAULT NULL,' +
      '`created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,' +
      '`updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,' +
      'PRIMARY KEY (`id`), KEY `idx_user_status` (`user_id`,`status`), KEY `idx_user_created` (`user_id`,`created_at`)) ' +
      "ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='本机浏览器通道的发送任务（方案C）'"
    );
  } else {
    // 老库补列：这里必须用独立 if 逐个判断，不能写成 else if 链
    // （写成链时只有第一个缺列会被补上，后面的永远轮不到）
    if (!(await colExists('agent_task', 'resume_of'))) {
      // 老库已有 agent_task 但缺 resume_of（断线续跑来源）
      await q('ALTER TABLE `agent_task` ADD COLUMN `resume_of` BIGINT UNSIGNED DEFAULT NULL ' +
        "COMMENT '断线续跑来源：被接续的任务 id（NULL=全新任务）'");
    }
    if (!(await colExists('agent_task', 'title_id'))) {
      // 发送时选了哪条发票抬头：续跑要沿用它，否则同一批消息里会混进两个抬头
      await q('ALTER TABLE `agent_task` ADD COLUMN `title_id` INT UNSIGNED DEFAULT NULL ' +
        "COMMENT '发送时选用的发票抬头（app_invoice_title.id；NULL=用账号上的老字段）'");
    }
  }

  // ── 平台商品价格缓存（v0.2.94）──
  //    齐货通 / 阿发取过一次价就落库，页面查询优先读库（不打平台），
  //    只有点「重新取价」才强制去平台拉新并更新本表。唯一键 kind+brand_id+goods_id：按品牌方共用一份。
  if (!(await tableExists('goods_price_cache'))) {
    await q(
      'CREATE TABLE `goods_price_cache` (' +
      '  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,' +
      "  `kind`        VARCHAR(8)    NOT NULL              COMMENT '价格来源：qht=齐货通 / afa=城配速达'," +
      "  `brand_id`    INT           NOT NULL DEFAULT 0    COMMENT '品牌方（brand.id）：同品牌共用一份'," +
      "  `goods_id`    VARCHAR(64)   NOT NULL              COMMENT '平台商品ID（齐货通/阿发 goodsId）'," +
      "  `goods_name`  VARCHAR(512)  NOT NULL DEFAULT ''   COMMENT '商品名称（取价时的快照）'," +
      "  `unit_price`  DECIMAL(12,4) DEFAULT NULL          COMMENT '折合小单位单价'," +
      "  `pack_price`  DECIMAL(12,2) DEFAULT NULL          COMMENT '整件价（qht=saleIP / afa=salesPrice）'," +
      "  `pack_qty`    DECIMAL(12,2) DEFAULT NULL          COMMENT '一件含多少小单位'," +
      "  `spec`        VARCHAR(64)   DEFAULT NULL          COMMENT '规格文案'," +
      "  `small_unit`  VARCHAR(16)   DEFAULT NULL          COMMENT '小单位（瓶/罐/支，仅齐货通有）'," +
      "  `picture`     VARCHAR(512)  DEFAULT NULL          COMMENT '平台商品图'," +
      "  `raw_json`    MEDIUMTEXT    DEFAULT NULL          COMMENT '上游原始返回（排查用）'," +
      "  `fetched_at`  DATETIME      NOT NULL              COMMENT '取价时间'," +
      "  `updated_at`  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '最近写入时间'," +
      '  PRIMARY KEY (`id`),' +
      '  UNIQUE KEY `uk_pc_scope` (`kind`, `brand_id`, `goods_id`),' +
      '  KEY `idx_pc_goods` (`kind`, `goods_id`)' +
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci' +
      "  COMMENT='平台商品价格缓存（取一次即持久化，按品牌方共用）'"
    );
  }

  // ── 供应商 / 货单管理（v0.3.0）──
  //   两个新菜单沿用 app_user 逐列开关；supplier / waybill / waybill_image / waybill_upload_token
  //   是普通业务表。下面的 DDL 与 sql/schema.sql 必须同源（改一处就要改另一处）。
  const NEW_MENU_COLS = ['supplier_enabled', 'waybill_enabled'];
  for (const col of NEW_MENU_COLS) {
    if (!(await colExists('app_user', col))) {
      const label = col === 'supplier_enabled' ? '供应商管理页' : '货单管理页';
      await q(`ALTER TABLE \`app_user\` ADD COLUMN \`${col}\` TINYINT(1) NOT NULL DEFAULT 0 ` +
        `COMMENT '是否允许查看${label}（1=开启，超级管理员始终可见）'`);
    }
  }

  if (!(await tableExists('supplier'))) {
    await q(
      'CREATE TABLE `supplier` (' +
      '  `id`         INT           NOT NULL AUTO_INCREMENT,' +
      "  `user_id`    INT           NOT NULL DEFAULT 1   COMMENT '数据归属用户（员工录入时是所属主体账号）'," +
      "  `name`       VARCHAR(64)   NOT NULL             COMMENT '供应商名称（同账号下唯一）'," +
      "  `note`       VARCHAR(255)  DEFAULT NULL         COMMENT '备注（联系方式、结算方式等）'," +
      "  `created_by` VARCHAR(64)   DEFAULT NULL         COMMENT '录入人（登录账号）'," +
      "  `created_at` DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '新建日期'," +
      '  `updated_at` DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,' +
      '  PRIMARY KEY (`id`),' +
      '  UNIQUE KEY `uk_supplier_user_name` (`user_id`, `name`),' +
      '  KEY `idx_supplier_user` (`user_id`, `id`)' +
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci' +
      "  COMMENT='供应商字典（供应商管理页维护，货单引用）'"
    );
  }

  if (!(await tableExists('waybill'))) {
    await q(
      'CREATE TABLE `waybill` (' +
      '  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,' +
      "  `user_id`       INT           NOT NULL DEFAULT 1   COMMENT '数据归属用户（员工录入时是所属主体账号）'," +
      "  `supplier_id`   INT           NOT NULL DEFAULT 0   COMMENT '供应商（supplier.id）'," +
      "  `supplier_name` VARCHAR(64)   NOT NULL DEFAULT ''  COMMENT '建单时的供应商名称快照（供应商被删时兜底展示）'," +
      "  `amount`        DECIMAL(12,2) NOT NULL DEFAULT 0.00 COMMENT '货单金额（元）'," +
      "  `bill_date`     DATE          NOT NULL             COMMENT '货单日期（按此列查询与排序）'," +
      "  `invoice_status` TINYINT      NOT NULL DEFAULT 0   COMMENT '开票状态：0未开票 1已开票（v0.3.6）'," +
      "  `note`          VARCHAR(255)  DEFAULT NULL         COMMENT '备注（列表不再展示；历史导入时用来记原始行来源）'," +
      "  `created_by`    VARCHAR(64)   DEFAULT NULL         COMMENT '录入人（登录账号）'," +
      "  `created_at`    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '新建日期'," +
      '  `updated_at`    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,' +
      '  PRIMARY KEY (`id`),' +
      '  KEY `idx_waybill_user_date`  (`user_id`, `bill_date`),' +
      '  KEY `idx_waybill_user_sup`   (`user_id`, `supplier_id`),' +
      '  KEY `idx_waybill_user_ctime` (`user_id`, `created_at`)' +
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci' +
      "  COMMENT='货单（供应商 + 金额 + 货单日期 + 图片）'"
    );
  }

  if (!(await tableExists('waybill_image'))) {
    await q(
      'CREATE TABLE `waybill_image` (' +
      '  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,' +
      "  `user_id`    INT           NOT NULL DEFAULT 1   COMMENT '数据归属用户（员工操作时记所属主体账号）'," +
      "  `waybill_id` BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '所属货单（0=还没绑定，等电脑端点保存）'," +
      "  `token`      CHAR(32)      DEFAULT NULL         COMMENT '上传时用的临时令牌（绑定后清空）'," +
      "  `object_key` VARCHAR(512)  NOT NULL             COMMENT '七牛对象 key（不含域名，展示时签名）'," +
      "  `mime`       VARCHAR(64)   DEFAULT NULL         COMMENT '图片类型（image/jpeg 等）'," +
      "  `size`       INT UNSIGNED  DEFAULT NULL         COMMENT '图片字节数'," +
      "  `sort`       INT           NOT NULL DEFAULT 0   COMMENT '同单内展示顺序'," +
      '  `created_at` DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,' +
      '  PRIMARY KEY (`id`),' +
      '  KEY `idx_wi_waybill` (`waybill_id`, `user_id`, `sort`),' +
      '  KEY `idx_wi_token`   (`token`, `user_id`)' +
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci' +
      "  COMMENT='货单图片（存七牛 key；waybill_id=0 为待绑定）'"
    );
  }

  if (!(await tableExists('waybill_upload_token'))) {
    await q(
      'CREATE TABLE `waybill_upload_token` (' +
      "  `token`      CHAR(32)      NOT NULL             COMMENT '32 位十六进制随机串（URL 里带 ?t=）'," +
      "  `user_id`    INT           NOT NULL DEFAULT 1   COMMENT '图片归属用户（= 生成链接的人所属主体）'," +
      "  `created_by` VARCHAR(64)   DEFAULT NULL         COMMENT '生成链接的人（登录账号）'," +
      "  `expires_at` DATETIME      NOT NULL             COMMENT '失效时间（NOW()+5 分钟）'," +
      "  `used_count` INT           NOT NULL DEFAULT 0   COMMENT '已成功上传张数（仅统计）'," +
      '  `created_at` DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,' +
      '  PRIMARY KEY (`token`),' +
      '  KEY `idx_wut_expire` (`expires_at`),' +
      '  KEY `idx_wut_user`   (`user_id`, `created_at`)' +
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci' +
      "  COMMENT='货单图片的手机上传临时令牌（5 分钟有效）'"
    );
  }

  // ── 货单开票状态（v0.3.6）──
  //   列表页「图片」右边展示，点击可切换。历史数据一律默认 0（未开票）。
  if (await tableExists('waybill')) {
    if (!(await colExists('waybill', 'invoice_status'))) {
      await q(
        "ALTER TABLE `waybill` ADD COLUMN `invoice_status` TINYINT NOT NULL DEFAULT 0 " +
        "COMMENT '开票状态：0未开票 1已开票（v0.3.6）' AFTER `bill_date`"
      );
    }
  }

  // ── 供应商售后台账（v0.3.2）──
  //   售后管理菜单整页替换为「针对供应商的售后」，不再读牵牛花退单。
  //   凭证图继续存 qnh_after_attach（row_key 用 sup:<id>），那张表 v0.2.108 就有，不用动。
  //   旧的 qnh_refund_order 售后列 / qnh_after_manual 保留在库，只是界面不再展示。
  if (!(await tableExists('supplier_after'))) {
    await q(
      'CREATE TABLE `supplier_after` (' +
      '  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,' +
      "  `user_id`       INT           NOT NULL DEFAULT 1   COMMENT '数据归属用户（员工录入时是所属主体账号）'," +
      "  `supplier_id`   INT           NOT NULL DEFAULT 0   COMMENT '供应商（supplier.id，0=供应商已被删）'," +
      "  `supplier_name` VARCHAR(64)   NOT NULL DEFAULT ''  COMMENT '登记时的供应商名称快照（兜底展示）'," +
      "  `goods_desc`    VARCHAR(512)  NOT NULL DEFAULT ''  COMMENT '售后内容（商品/事由文字描述）'," +
      "  `amount`        DECIMAL(12,2) NOT NULL DEFAULT 0.00 COMMENT '售后金额（元）'," +
      "  `after_date`    DATE          NOT NULL             COMMENT '售后日期（按此列查询与排序）'," +
      "  `status`        TINYINT       NOT NULL DEFAULT 0   COMMENT '处理状态：0待处理 1已申请 2已退货 3已退款（人工推进，一键下一档）'," +
      "  `note`          VARCHAR(255)  DEFAULT NULL         COMMENT '备注'," +
      "  `handled_by`    VARCHAR(64)   DEFAULT NULL         COMMENT '最后处理人（登录账号）'," +
      '  `handled_at`    DATETIME      DEFAULT NULL         COMMENT \'最后处理时间\',' +
      "  `created_by`    VARCHAR(64)   DEFAULT NULL         COMMENT '录入人（登录账号）'," +
      "  `created_at`    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '新建日期'," +
      '  `updated_at`    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,' +
      '  PRIMARY KEY (`id`),' +
      '  KEY `idx_sa_user_date`   (`user_id`, `after_date`),' +
      '  KEY `idx_sa_user_sup`    (`user_id`, `supplier_id`),' +
      '  KEY `idx_sa_user_status` (`user_id`, `status`)' +
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci' +
      "  COMMENT='供应商售后台账（供应商 + 内容 + 金额 + 售后日期 + 凭证）'"
    );
  }

  // ── qht_order 齐货通订单（v0.3.3）──
  //   「我的 → 全部订单」接口拉回落库，账单支出项「齐货通当月订单金额」的数据源。
  //   只有这一张新表，无列变更、无数据迁移。
  if (!(await tableExists('qht_order'))) {
    await q(
      'CREATE TABLE `qht_order` (' +
      '  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,' +
      "  `user_id`        INT           NOT NULL               COMMENT '数据归属用户（齐货通登录态所属账号）'," +
      "  `order_no`       VARCHAR(32)   NOT NULL               COMMENT '订单编号（DD 开头）'," +
      "  `status`         TINYINT       NOT NULL DEFAULT 0     COMMENT '平台状态码'," +
      "  `status_name`    VARCHAR(32)   NOT NULL DEFAULT ''    COMMENT '平台状态名（已发货/已取消/已完成…）'," +
      "  `pay_flag`       TINYINT       NOT NULL DEFAULT 0     COMMENT '支付标记：0未支付 1线下部分结款 2线下全部结款'," +
      "  `pay_status`     TINYINT       NOT NULL DEFAULT 0     COMMENT '支付状态码（1=已支付，平台语义）'," +
      "  `pay_status_name` VARCHAR(32)  NOT NULL DEFAULT ''    COMMENT '支付状态名（已支付/未支付…）'," +
      "  `store_name`     VARCHAR(64)   NOT NULL DEFAULT ''    COMMENT '发货仓库'," +
      "  `sale_no`        VARCHAR(32)   NOT NULL DEFAULT ''    COMMENT '出货单号（XS 开头，部分状态才有）'," +
      "  `ipcnt`          INT           NOT NULL DEFAULT 0     COMMENT '件数'," +
      "  `spcnt`          INT           NOT NULL DEFAULT 0     COMMENT '散数'," +
      '  `payable_money`  DECIMAL(12,2) NOT NULL DEFAULT 0.00  COMMENT \'实付款（元）\',' +
      "  `order_time`     DATETIME      NOT NULL               COMMENT '下单时间（按此列归月）'," +
      '  `created_at`     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT \'首次拉取时间\',' +
      '  `updated_at`     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,' +
      '  PRIMARY KEY (`id`),' +
      '  UNIQUE KEY `uq_qo_user_no`  (`user_id`, `order_no`),' +
      '  KEY `idx_qo_user_time`      (`user_id`, `order_time`)' +
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci' +
      "  COMMENT='齐货通订单（账单支出项「齐货通当月订单金额」数据源）'"
    );
  }

  // ── 「员工有的菜单，主体默认也有」（v0.3.0 用户要求）──
  //   老板给员工开了某个菜单、自己却因为没开而看不见，是最容易被投诉的形态。
  //   规则**只加不减**：只把员工的 1 并到主体，从不把主体的 1 改回 0 —— 所以每次启动都跑也安全，
  //   也能把历史上「员工有、主体没有」的账号一次性补齐。
  //   ⚠ 列名在这里硬编码一份：不能 require server.js 的 MENU_PERMS（那边反过来依赖本文件，会循环）。
  //     新增菜单时这里要同步加列名。
  const MENU_COLS = [
    'qnh_refund_enabled', 'qnh_profit_enabled', 'product_enabled', 'market_enabled',
    'billing_enabled', 'replenish_enabled', 'price_enabled', 'after_sale_enabled',
    'supplier_enabled', 'waybill_enabled',
  ];
  try {
    const usable = [];
    for (const col of MENU_COLS) if (await colExists('app_user', col)) usable.push(col);
    if (usable.length) {
      const pick = usable.map((c) => `MAX(\`${c}\`) AS \`${c}\``).join(', ');
      const sets = usable.map((c) => `o.\`${c}\` = GREATEST(o.\`${c}\`, s.\`${c}\`)`).join(', ');
      await q(
        'UPDATE `app_user` o JOIN (' +
        `  SELECT owner_id, ${pick} FROM \`app_user\` WHERE owner_id IS NOT NULL AND owner_id > 0 GROUP BY owner_id` +
        `) s ON s.owner_id = o.id SET ${sets}`
      );
    }
  } catch (e) {
    // 回填失败不影响启动：只是少了一次历史补齐，新授权走 runtime 的自动同步
    console.warn('[db] 菜单权限回填（员工→主体）失败：', (e && e.message) || e);
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

  // 牵牛花登录态：老结构是「全系统共享一份（user_id=0）」，按用户隔离后归到 admin 名下。
  // 注意：这里不能复用 migrate() 里的 tableExists（作用域不同，会抛 ReferenceError 被静默吞掉），
  // 直接用 information_schema 判断。
  try {
    const hasTbl = (await q(
      `SELECT COUNT(*) AS n FROM information_schema.TABLES
       WHERE TABLE_SCHEMA=? AND TABLE_NAME='qnh_session'`,
      [dbName]
    ))[0].n > 0;
    if (hasTbl) {
      const legacy = await q('SELECT id FROM `qnh_session` WHERE user_id = 0 ORDER BY id DESC');
      const mine = await q('SELECT id FROM `qnh_session` WHERE user_id = ? LIMIT 1', [adminId]);
      if (legacy.length && !mine.length) {
        await q('UPDATE `qnh_session` SET user_id = ? WHERE id = ?', [adminId, legacy[0].id]);
        console.log(`[db] 历史牵牛花登录态（qnh_session#${legacy[0].id}）已归属 admin（id=${adminId}）`);
      }
    }
  } catch (e) { /* 忽略：表不存在或已迁移 */ }
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
