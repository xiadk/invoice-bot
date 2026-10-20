-- ============================================================================
-- invoice-bot 数据库结构（MySQL / MariaDB 通用，字符集 utf8mb4）
--
-- 用法: mysql -h127.0.0.1 -P3306 -uroot -p < sql/schema.sql
--       或由 node import-to-db.js 自动执行（推荐，无需手工建库）
--
-- 全部表名、字段均带中文注释，便于直接在看板/客户端中理解含义。
-- 本文件使用 CREATE TABLE IF NOT EXISTS，重复执行不会删除已有数据。
--
-- ── 多租户（多用户）说明 ────────────────────────────────────────────────
--   本库采用「共享库 + user_id 列」的多租户方案：所有业务表都带 `user_id`，
--   看板/接口一律按当前登录用户过滤，实现用户之间的数据隔离。
--   账号体系见 app_user 表（role=admin 为超级管理员，可管理所有用户并查看全部数据）。
-- ============================================================================

CREATE DATABASE IF NOT EXISTS `invoice_bot`
  DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;

USE `invoice_bot`;

-- ----------------------------------------------------------------------------
-- 表 0: app_user —— 账号表（多用户登录 + 超级管理员）
--   role   = admin：超级管理员，可新增/禁用用户、重置密码、查看所有人的看板与映射数据
--   role   = user ：普通用户，只能看自己的看板与名称映射
--   company_name / tax_no / email：该用户的开票抬头（催收话术里的 {companyName}/{taxNo}/{email}）
--   token_version：改密/禁用时 +1，使此前签发的所有登录态立即失效
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `app_user` (
  `id`                   INT           NOT NULL AUTO_INCREMENT COMMENT '用户ID（同时也是数据归属的 user_id）',
  `username`             VARCHAR(64)   NOT NULL                COMMENT '登录账号（唯一）',
  `password_hash`        VARCHAR(255)  NOT NULL                COMMENT '密码哈希（scrypt，格式 scrypt:盐:哈希）',
  `role`                 ENUM('admin','user') NOT NULL DEFAULT 'user' COMMENT '角色：admin=超级管理员，user=普通用户',
  `status`               ENUM('active','disabled') NOT NULL DEFAULT 'active' COMMENT '账号状态：active=正常，disabled=已禁用（禁用后无法登录，已登录会话立即失效）',
  `company_name`         VARCHAR(255)  DEFAULT NULL            COMMENT '开票抬头：公司名称（催收消息 {companyName}）',
  `tax_no`               VARCHAR(64)   DEFAULT NULL            COMMENT '开票抬头：纳税人识别号（催收消息 {taxNo}）',
  `email`                VARCHAR(160)  DEFAULT NULL            COMMENT '开票抬头：收票邮箱（催收消息 {email}）',
  `display_name`         VARCHAR(64)   DEFAULT NULL            COMMENT '显示名（可选，看板右上角展示）',
  `note`                 VARCHAR(255)  DEFAULT NULL            COMMENT '备注（管理员填写，如所属业务线）',
  `token_version`        INT           NOT NULL DEFAULT 1      COMMENT '会话版本：改密/禁用时 +1，旧登录态立即失效',
  `must_change_password` TINYINT(1)    NOT NULL DEFAULT 0      COMMENT '是否强制下次登录修改密码',
  `created_by`           INT           DEFAULT NULL            COMMENT '创建者（管理员ID）',
  `last_login_at`        DATETIME      DEFAULT NULL            COMMENT '最近登录时间',
  `created_at`           DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at`           DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_app_user_username` (`username`),
  KEY `idx_app_user_role` (`role`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  COMMENT='账号表（多用户登录；role=admin 为超级管理员）';

-- ----------------------------------------------------------------------------
-- （login_state 表已废除：2026-10-13 起服务器不保存 1688 登录态、不用服务端浏览器发送，
--   登录与发送只在用户本机浏览器执行。老库里如仍有该表，确认无人使用后可手动 DROP。）
-- ----------------------------------------------------------------------------

-- ----------------------------------------------------------------------------
-- 表 1: invoice_order —— 1688 完成订单表
--   数据来源: data/users/<user_id>/完成订单/*.xlsx（1688「已买到的货品」后台导出）
--   看板口径: 订单数 / 订单金额 / 待开票金额 / 催收名单
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `invoice_order` (
  `order_no`          VARCHAR(32)   NOT NULL                COMMENT '订单编号（1688订单号，主键；多SKU续行已按主行去重）',
  `user_id`           INT           NOT NULL DEFAULT 1      COMMENT '数据归属用户ID（多租户隔离键，见 app_user.id）',
  `buyer_company`     VARCHAR(255)  DEFAULT NULL            COMMENT '买家公司名（本方，即抬头公司）',
  `buyer_login`       VARCHAR(128)  DEFAULT NULL            COMMENT '买家会员名（本方1688登录ID）',
  `seller_company`    VARCHAR(255)  DEFAULT NULL            COMMENT '卖家公司名（订单里的商家名称，看板与映射统计的主维度）',
  `seller_login`      VARCHAR(128)  DEFAULT NULL            COMMENT '卖家会员名（1688登录ID，发催收消息用的 touid）',
  `goods_amount`      DECIMAL(14,2) DEFAULT NULL            COMMENT '货品总价(元)',
  `freight_amount`    DECIMAL(14,2) DEFAULT NULL            COMMENT '运费(元)',
  `discount_amount`   DECIMAL(14,2) DEFAULT NULL            COMMENT '涨价或折扣(元)，负数表示折扣',
  `pay_amount`        DECIMAL(14,2) DEFAULT NULL            COMMENT '实付款(元)，看板金额统计口径',
  `order_status`      VARCHAR(32)   DEFAULT NULL            COMMENT '订单状态（交易成功 / 交易关闭 等）',
  `created_at`        DATETIME      DEFAULT NULL            COMMENT '订单创建时间',
  `pay_time`          DATETIME      DEFAULT NULL            COMMENT '订单付款时间',
  `goods_title`       VARCHAR(512)  DEFAULT NULL            COMMENT '货品标题（首个SKU）',
  `quantity`          DECIMAL(14,4) DEFAULT NULL            COMMENT '数量',
  `unit`              VARCHAR(16)   DEFAULT NULL            COMMENT '单位',
  `logistics_company` VARCHAR(64)   DEFAULT NULL            COMMENT '物流公司',
  `tracking_no`       VARCHAR(64)   DEFAULT NULL            COMMENT '运单号',
  `invoice_title`     VARCHAR(255)  DEFAULT NULL            COMMENT '发票：购货单位名称（1688后台填写的抬头）',
  `invoice_tax_no`    VARCHAR(64)   DEFAULT NULL            COMMENT '发票：纳税人识别号',
  `source_file`       VARCHAR(160)  DEFAULT NULL            COMMENT '数据来源文件名',
  `invoice_state`     ENUM('none','applying','issued') NOT NULL DEFAULT 'none'
                                                            COMMENT '订单级开票状态（有效状态）：none=未申请，applying=已申请，issued=已开票',
  `state_source`      ENUM('platform','manual') NOT NULL DEFAULT 'platform'
                                                            COMMENT '开票状态来源：platform=平台刷新，manual=人工确认（商家线下已开票）',
  `state_updated_at`  DATETIME      DEFAULT NULL            COMMENT '开票状态最后更新时间',
  `state_note`        VARCHAR(255)  DEFAULT NULL            COMMENT '开票状态备注（人工确认时的说明）',
  `imported_at`       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '入库时间',
  PRIMARY KEY (`order_no`),
  KEY `idx_user_id`        (`user_id`),
  KEY `idx_user_seller_login`   (`user_id`, `seller_login`),
  KEY `idx_seller_login`   (`seller_login`),
  KEY `idx_seller_company` (`seller_company`),
  KEY `idx_invoice_state`  (`invoice_state`),
  KEY `idx_pay_time`       (`pay_time`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  COMMENT='1688完成订单表（源：data/users/<id>/完成订单/*.xlsx）';

-- 老库增量补列（新装库上面的 CREATE TABLE 已含该列）
ALTER TABLE `invoice_order`
  ADD COLUMN IF NOT EXISTS `user_id` INT NOT NULL DEFAULT 1
  COMMENT '数据归属用户ID（多租户隔离键，见 app_user.id）' AFTER `order_no`;
ALTER TABLE `invoice_order` ADD KEY IF NOT EXISTS `idx_user_id` (`user_id`);
ALTER TABLE `invoice_order` ADD KEY IF NOT EXISTS `idx_user_seller_login` (`user_id`, `seller_login`);

-- ----------------------------------------------------------------------------
-- 表 2: issued_invoice —— 历史已开票数据表（税务局全量发票导出）
--   数据来源: data/users/<user_id>/已开票订单/*.xlsx（电子税务局「全量发票查询」导出）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `issued_invoice` (
  `id`                BIGINT        NOT NULL AUTO_INCREMENT COMMENT '自增主键',
  `user_id`           INT           NOT NULL DEFAULT 1      COMMENT '数据归属用户ID（多租户隔离键，见 app_user.id）',
  `row_hash`          CHAR(40)      NOT NULL                COMMENT '行指纹（md5，用于重复导入自动去重；与 user_id 组成唯一键）',
  `seq_no`            INT           DEFAULT NULL            COMMENT '税务局导出文件中的序号',
  `invoice_code`      VARCHAR(32)   DEFAULT NULL            COMMENT '发票代码（数电票为空）',
  `invoice_no`        VARCHAR(32)   DEFAULT NULL            COMMENT '发票号码',
  `e_invoice_no`      VARCHAR(32)   DEFAULT NULL            COMMENT '数电发票号码（20位，数电票主标识）',
  `seller_tax_no`     VARCHAR(64)   DEFAULT NULL            COMMENT '销方识别号（开票方纳税人识别号）',
  `seller_name`       VARCHAR(255)  DEFAULT NULL            COMMENT '销方名称（税务局口径，与1688商家名不同）',
  `seller_company`    VARCHAR(255)  DEFAULT NULL            COMMENT '映射后的1688卖家公司名（统计用，来自映射表）',
  `buyer_tax_no`      VARCHAR(64)   DEFAULT NULL            COMMENT '购方识别号（本方税号）',
  `buyer_name`        VARCHAR(255)  DEFAULT NULL            COMMENT '购买方名称（本方公司名）',
  `invoice_date`      DATETIME      DEFAULT NULL            COMMENT '开票日期',
  `tax_category_code` VARCHAR(32)   DEFAULT NULL            COMMENT '税收分类编码',
  `special_biz_type`  VARCHAR(64)   DEFAULT NULL            COMMENT '特定业务类型',
  `goods_name`        VARCHAR(512)  DEFAULT NULL            COMMENT '货物或应税劳务名称',
  `spec`              VARCHAR(255)  DEFAULT NULL            COMMENT '规格型号',
  `unit`              VARCHAR(16)   DEFAULT NULL            COMMENT '单位',
  `quantity`          DECIMAL(14,4) DEFAULT NULL            COMMENT '数量',
  `unit_price`        DECIMAL(18,6) DEFAULT NULL            COMMENT '单价',
  `amount`            DECIMAL(14,2) DEFAULT NULL            COMMENT '金额（不含税）',
  `tax_rate`          VARCHAR(16)   DEFAULT NULL            COMMENT '税率（如 13%）',
  `tax_amount`        DECIMAL(14,2) DEFAULT NULL            COMMENT '税额',
  `total_amount`      DECIMAL(14,2) DEFAULT NULL            COMMENT '价税合计（看板已开票金额口径）',
  `invoice_source`    VARCHAR(64)   DEFAULT NULL            COMMENT '发票来源（如 电子发票服务平台）',
  `invoice_kind`      VARCHAR(64)   DEFAULT NULL            COMMENT '发票票种（如 数电发票（普通发票））',
  `invoice_status`    VARCHAR(32)   DEFAULT NULL            COMMENT '发票状态（正常 / 作废 / 红冲 等）',
  `is_positive`       VARCHAR(8)    DEFAULT NULL            COMMENT '是否正数发票（是 / 否）',
  `risk_level`        VARCHAR(32)   DEFAULT NULL            COMMENT '发票风险等级',
  `drawer`            VARCHAR(64)   DEFAULT NULL            COMMENT '开票人',
  `remark`            VARCHAR(512)  DEFAULT NULL            COMMENT '备注（常含1688店铺名线索，如「1688 谨锐优选」）',
  `source_sheet`      VARCHAR(64)   DEFAULT NULL            COMMENT '来源工作表（信息汇总表 / 发票基础信息）',
  `source_file`       VARCHAR(160)  DEFAULT NULL            COMMENT '来源文件名',
  `imported_at`       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '入库时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_user_row_hash`    (`user_id`, `row_hash`),
  KEY `idx_user_id`                (`user_id`),
  KEY `idx_e_invoice_no`           (`e_invoice_no`),
  KEY `idx_seller_name`            (`seller_name`),
  KEY `idx_seller_company`         (`seller_company`),
  KEY `idx_invoice_date`           (`invoice_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  COMMENT='历史已开票数据表（源：data/users/<id>/已开票订单/*.xlsx）';

-- 老库增量升级：补 user_id 列；唯一键由「全局 row_hash」改为「(user_id,row_hash)」
ALTER TABLE `issued_invoice`
  ADD COLUMN IF NOT EXISTS `user_id` INT NOT NULL DEFAULT 1
  COMMENT '数据归属用户ID（多租户隔离键，见 app_user.id）' AFTER `id`;
ALTER TABLE `issued_invoice` DROP INDEX IF EXISTS `uk_row_hash`;
ALTER TABLE `issued_invoice` ADD UNIQUE KEY IF NOT EXISTS `uk_user_row_hash` (`user_id`, `row_hash`);
ALTER TABLE `issued_invoice` ADD KEY IF NOT EXISTS `idx_user_id` (`user_id`);

-- ----------------------------------------------------------------------------
-- 表 3: seller_name_mapping —— 销方名称 ↔ 1688 商家名称 映射表（按用户隔离）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `seller_name_mapping` (
  `id`              INT          NOT NULL AUTO_INCREMENT COMMENT '自增主键',
  `user_id`         INT          NOT NULL DEFAULT 1      COMMENT '数据归属用户ID（多租户隔离键，见 app_user.id）',
  `tax_seller_name` VARCHAR(255) NOT NULL                COMMENT '税务局销方名称（与 user_id 组成唯一键）',
  `seller_company`  VARCHAR(255) NULL                    COMMENT '对应的1688卖家公司名',
  `seller_login`    VARCHAR(128) NULL                    COMMENT '对应的1688卖家会员名（登录ID）',
  `match_type`      VARCHAR(16)  NOT NULL DEFAULT 'manual' COMMENT '匹配方式：auto=系统自动匹配，manual=人工维护',
  `match_rule`      VARCHAR(64)  DEFAULT NULL            COMMENT '自动匹配命中的规则（exact / normalized / contains / login / remark）',
  `is_confirmed`    TINYINT(1)   NOT NULL DEFAULT 0      COMMENT '是否人工确认：0=自动匹配待人工复核，1=已确认',
  `is_ignored`      TINYINT(1)   NOT NULL DEFAULT 0      COMMENT '是否忽略：1=该销方名称确认无对应1688商家，从待比对列表与统计中剔除（可恢复）',
  `note`            VARCHAR(255) DEFAULT NULL            COMMENT '备注',
  `created_at`      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at`      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_user_tax_name` (`user_id`, `tax_seller_name`),
  KEY `idx_user_id`             (`user_id`),
  KEY `idx_seller_login`        (`seller_login`),
  KEY `idx_seller_company`      (`seller_company`),
  KEY `idx_is_ignored`          (`is_ignored`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  COMMENT='税务局销方名称与1688商家名称的映射表（按用户隔离；is_ignored=1 表示确认无对应商家）';

-- 老库增量升级
ALTER TABLE `seller_name_mapping`
  ADD COLUMN IF NOT EXISTS `user_id` INT NOT NULL DEFAULT 1
  COMMENT '数据归属用户ID（多租户隔离键，见 app_user.id）' AFTER `id`;
ALTER TABLE `seller_name_mapping`
  ADD COLUMN IF NOT EXISTS `is_ignored` TINYINT(1) NOT NULL DEFAULT 0
  COMMENT '是否忽略：1=该销方名称确认无对应1688商家，从待比对列表与统计中剔除（可恢复）' AFTER `is_confirmed`;
ALTER TABLE `seller_name_mapping` DROP INDEX IF EXISTS `uk_tax_seller_name`;
ALTER TABLE `seller_name_mapping` ADD UNIQUE KEY IF NOT EXISTS `uk_user_tax_name` (`user_id`, `tax_seller_name`);
ALTER TABLE `seller_name_mapping` ADD KEY IF NOT EXISTS `idx_user_id` (`user_id`);
ALTER TABLE `seller_name_mapping` ADD KEY IF NOT EXISTS `idx_is_ignored` (`is_ignored`);

-- ----------------------------------------------------------------------------
-- 表 4: send_log —— 催收消息发送记录（一行 = 一次发送尝试）
--   「催收次数」= SUM(result='ok')、「最近催收时间」= MAX(sent_at)。
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `send_log` (
  `id`             INT          NOT NULL AUTO_INCREMENT COMMENT '自增主键',
  `user_id`        INT          NOT NULL DEFAULT 1      COMMENT '数据归属用户ID（多租户隔离键，见 app_user.id）',
  `send_date`      DATE         NOT NULL                COMMENT '发送日期（用于按天统计/每日限额）',
  `seller_login`   VARCHAR(128) NOT NULL                COMMENT '卖家会员名（1688登录ID）',
  `seller_company` VARCHAR(255) DEFAULT NULL            COMMENT '卖家公司名（冗余，便于直接查看）',
  `result`         VARCHAR(16)  NOT NULL DEFAULT 'ok'   COMMENT '发送结果：ok=成功，fail=失败',
  `channel`        VARCHAR(16)  NOT NULL DEFAULT 'web'  COMMENT '发送入口：web=看板，cli=命令行',
  `amount`         DECIMAL(14,2) DEFAULT NULL           COMMENT '本次催收的待开票总金额（发送当时的快照；老记录可能为空）',
  `order_nos`      TEXT         DEFAULT NULL            COMMENT '本次催收包含的订单号（多个用「；」分隔，发送当时快照）',
  `error`          VARCHAR(255) DEFAULT NULL            COMMENT '失败原因摘要（result=fail 时记录，便于排查）',
  `sent_at`        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '发送时间（最近催收时间取 MAX）',
  PRIMARY KEY (`id`),
  KEY `idx_user_id`      (`user_id`),
  KEY `idx_user_login`   (`user_id`, `seller_login`),
  KEY `idx_seller_login` (`seller_login`),
  KEY `idx_sent_at`      (`sent_at`),
  KEY `idx_send_date`    (`send_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  COMMENT='催收消息发送记录（一行=一次发送，看板统计催收次数与最近催收时间）';

-- 老库增量补列
ALTER TABLE `send_log`
  ADD COLUMN IF NOT EXISTS `user_id` INT NOT NULL DEFAULT 1
  COMMENT '数据归属用户ID（多租户隔离键，见 app_user.id）' AFTER `id`;
ALTER TABLE `send_log`
  ADD COLUMN IF NOT EXISTS `amount` DECIMAL(14,2) DEFAULT NULL
  COMMENT '本次催收的待开票总金额（发送当时的快照；老记录可能为空）' AFTER `channel`;
ALTER TABLE `send_log`
  ADD COLUMN IF NOT EXISTS `order_nos` TEXT DEFAULT NULL
  COMMENT '本次催收包含的订单号（多个用「；」分隔，发送当时快照）' AFTER `amount`;
ALTER TABLE `send_log`
  ADD COLUMN IF NOT EXISTS `error` VARCHAR(255) DEFAULT NULL
  COMMENT '失败原因摘要（result=fail 时记录，便于排查）' AFTER `order_nos`;
ALTER TABLE `send_log` ADD KEY IF NOT EXISTS `idx_user_id` (`user_id`);
ALTER TABLE `send_log` ADD KEY IF NOT EXISTS `idx_user_login` (`user_id`, `seller_login`);

-- ----------------------------------------------------------------------------
-- 表 5: import_log —— 数据导入日志
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `import_log` (
  `id`          INT          NOT NULL AUTO_INCREMENT COMMENT '自增主键',
  `user_id`     INT          NOT NULL DEFAULT 1      COMMENT '数据归属用户ID（多租户隔离键，见 app_user.id）',
  `kind`        VARCHAR(16)  NOT NULL                COMMENT '导入类型：order=完成订单，invoice=已开票订单',
  `source_file` VARCHAR(160) NOT NULL                COMMENT '来源文件名',
  `total_rows`  INT          DEFAULT NULL            COMMENT '文件数据总行数',
  `inserted`    INT          NOT NULL DEFAULT 0      COMMENT '本次写入行数',
  `skipped`     INT          NOT NULL DEFAULT 0      COMMENT '跳过行数（空行/续行/合计行/重复行）',
  `auto_mapped` INT          NOT NULL DEFAULT 0      COMMENT '自动匹配成功的销方名称数（仅 invoice）',
  `unmatched`   INT          NOT NULL DEFAULT 0      COMMENT '未能匹配的销方名称数（仅 invoice）',
  `status`      VARCHAR(16)  NOT NULL DEFAULT 'ok'   COMMENT '导入结果：ok=成功，error=失败',
  `message`     VARCHAR(512) DEFAULT NULL            COMMENT '错误或提示信息',
  `imported_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '导入时间',
  PRIMARY KEY (`id`),
  KEY `idx_user_id`     (`user_id`),
  KEY `idx_kind`        (`kind`),
  KEY `idx_imported_at` (`imported_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  COMMENT='数据导入日志';

ALTER TABLE `import_log`
  ADD COLUMN IF NOT EXISTS `user_id` INT NOT NULL DEFAULT 1
  COMMENT '数据归属用户ID（多租户隔离键，见 app_user.id）' AFTER `id`;
ALTER TABLE `import_log` ADD KEY IF NOT EXISTS `idx_user_id` (`user_id`);

-- ----------------------------------------------------------------------------
-- 视图: v_unmatched_seller_name —— 待人工比对的销方名称清单（按用户分组）
--   看板「名称映射」页用：SELECT * FROM v_unmatched_seller_name WHERE user_id = ?
--   排除两类销方名称：① 已建立映射（seller_company 非空）② 人工已忽略（is_ignored=1）
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW `v_unmatched_seller_name` AS
SELECT
  i.`user_id`                           AS `user_id`,
  i.`seller_name`                       AS `tax_seller_name`,
  COUNT(*)                              AS `invoice_rows`,
  SUM(i.`total_amount`)                 AS `invoice_amount`,
  MIN(i.`invoice_date`)                 AS `first_invoice_date`,
  MAX(i.`invoice_date`)                 AS `last_invoice_date`,
  MAX(i.`seller_tax_no`)                AS `seller_tax_no`,
  MAX(i.`remark`)                       AS `remark`
FROM `issued_invoice` i
LEFT JOIN `seller_name_mapping` m
       ON m.`user_id` = i.`user_id`
      AND m.`tax_seller_name` = i.`seller_name`
      AND (m.`is_ignored` = 1 OR m.`seller_company` IS NOT NULL)
WHERE m.`id` IS NULL
GROUP BY i.`user_id`, i.`seller_name`;

-- ----------------------------------------------------------------------------
-- agent_task —— 本机浏览器通道（方案C）的发送任务
--   一行 = 一次由「用户本机浏览器」执行的发送任务；服务器只做编排与结果入库。
--   逐条发送结果仍写入 send_log；本表用于进度展示与断线续跑。
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `agent_task` (
  `id`           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`      INT UNSIGNED NOT NULL,
  `status`       ENUM('queued','running','done','aborted','failed') NOT NULL DEFAULT 'queued'
                 COMMENT 'queued=已创建待下发, running=执行中, done=完成, aborted=被中断, failed=失败',
  `total`        INT NOT NULL DEFAULT 0  COMMENT '本批卖家数',
  `done`         INT NOT NULL DEFAULT 0  COMMENT '已处理卖家数',
  `ok`           INT NOT NULL DEFAULT 0  COMMENT '成功数',
  `fail`         INT NOT NULL DEFAULT 0  COMMENT '失败数',
  `items`        JSON DEFAULT NULL
                 COMMENT '清单 [{loginId,company,amount,orderNos,status}]，status=pending|ok|fail，用于断线续跑',
  `error`        VARCHAR(255) DEFAULT NULL COMMENT '中断/失败原因摘要',
  `resume_of`    BIGINT UNSIGNED DEFAULT NULL
                 COMMENT '断线续跑来源：被接续的任务 id（NULL=全新任务）',
  `started_at`   DATETIME DEFAULT NULL,
  `finished_at`  DATETIME DEFAULT NULL,
  `created_at`   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_user_status`  (`user_id`, `status`),
  KEY `idx_user_created` (`user_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='本机浏览器通道的发送任务（方案C）';

-- ----------------------------------------------------------------------------
-- agent_device —— 本机助手/书签的设备令牌（2026-10-14 起）
--   ⚠ 背景：旧方案用「纳税人识别号（税号）」当配对码。税号是半公开信息（印在发票上、
--      可被查询），一旦泄露，他人即可冒充该用户连上本机通道、接收其订单/发票/催收文案。
--      故改为：网站签发一次性绑定令牌 → 助手换取长期「设备令牌」→ 之后一律用设备令牌连接。
--   安全：数据库**只存令牌的 sha256 哈希**，不存明文；令牌仅在签发那一刻返回一次。
--   撤销：revoked_at 非空即失效；可在看板「设备管理」里逐个踢下线。
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `agent_device` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`     INT UNSIGNED NOT NULL                COMMENT '归属账号（app_user.id）',
  `token_hash`  CHAR(64)     NOT NULL                COMMENT '设备令牌的 sha256 十六进制（不存明文）',
  `device_name` VARCHAR(128) NOT NULL DEFAULT ''     COMMENT '设备名（如「办公室台式机」）',
  `os`          VARCHAR(64)  NOT NULL DEFAULT ''     COMMENT '操作系统标识',
  `agent_ver`   VARCHAR(32)  NOT NULL DEFAULT ''     COMMENT '助手版本号',
  `kind`        ENUM('agent','bookmarklet') NOT NULL DEFAULT 'agent'
                                                     COMMENT '类型：agent=桌面助手，bookmarklet=书签工具',
  `last_ip`     VARCHAR(64)  NOT NULL DEFAULT ''     COMMENT '最近连接来源 IP',
  `last_seen_at` DATETIME    DEFAULT NULL            COMMENT '最近一次成功连接时间',
  `revoked_at`  DATETIME     DEFAULT NULL            COMMENT '撤销时间（非空=已失效）',
  `created_at`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_agent_device_token` (`token_hash`),
  KEY `idx_agent_device_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='本机助手/书签的设备令牌（替代「税号当配对码」）';

-- ----------------------------------------------------------------------------
-- 表 6: profit_alert_rule —— 美团「毛利明细」告警规则（每用户一行，2026-10-20 新增）
--   采集在用户本机助手执行（electron/agent/profit-watch.js，用本机浏览器打开
--   https://qnh.meituan.com 报表页只读 DOM）；**服务器不登录美团、不存美团登录态**。
--   本表只承载「判定与推送」的配置，以及企业微信机器人 key（仅本表存，不回传前端明文）。
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `profit_alert_rule` (
  `user_id`                 INT UNSIGNED  NOT NULL                COMMENT '数据归属用户ID（app_user.id）',
  `enabled`                 TINYINT(1)    NOT NULL DEFAULT 1      COMMENT '是否启用采集（0=本机助手停止采集）',
  `watch_url`               VARCHAR(500)  NOT NULL DEFAULT ''     COMMENT '监控页面地址（仅允许 qnh.meituan.com 域名）',
  `poll_interval_sec`       INT           NOT NULL DEFAULT 60     COMMENT '读取 DOM 的间隔（秒）。不发请求，仅本机页面内读取',
  `refresh_every_sec`       INT           NOT NULL DEFAULT 300    COMMENT '多少秒点一次页面自带的刷新按钮（0=不刷新）',
  `jitter_ratio`            DECIMAL(4,2)   NOT NULL DEFAULT 0.20  COMMENT '间隔随机抖动比例（0~0.5），让节奏不像机器',
  `threshold`               DECIMAL(14,2) NOT NULL DEFAULT 0.00   COMMENT '阈值：线上毛利小于该值即告警（默认 0=负毛利）',
  `value_column`            VARCHAR(64)   NOT NULL DEFAULT '线上毛利' COMMENT '判定用列（按表头文字模糊匹配）',
  `amount_column`           VARCHAR(64)   DEFAULT NULL            COMMENT '金额列（仅展示用）',
  `status_column`           VARCHAR(64)   NOT NULL DEFAULT '订单状态' COMMENT '状态列（用于排除取消/退款）',
  `store_column`            VARCHAR(64)   NOT NULL DEFAULT '店铺名称' COMMENT '店铺列',
  `order_column`            VARCHAR(64)   NOT NULL DEFAULT '订单号'   COMMENT '订单号列',
  `ignore_status`           JSON          DEFAULT NULL            COMMENT '要排除的状态数组，如 ["已取消","已退款"]',
  `include_stores`          JSON          DEFAULT NULL            COMMENT '只关注这些店铺（空=全部）',
  `exclude_stores`          JSON          DEFAULT NULL            COMMENT '排除这些店铺',
  `excludes`                JSON          DEFAULT NULL            COMMENT '关键词排除（命中店铺名/商品名/备注即跳过）',
  `first_page_only`         TINYINT(1)    NOT NULL DEFAULT 1      COMMENT '只读第一页（最安全；0=自动翻页）',
  `push_channel`            ENUM('wecom','none') NOT NULL DEFAULT 'wecom' COMMENT '推送渠道：wecom=企业微信机器人，none=只记录不推送',
  `wecom_key_mode`          ENUM('builtin','custom') NOT NULL DEFAULT 'builtin' COMMENT 'builtin=用系统内置机器人，custom=用自定义 key',
  `wecom_key`               VARCHAR(128)  DEFAULT NULL            COMMENT '自定义机器人 key（仅存库，永不回传明文）',
  `wecom_mention`           VARCHAR(200)  DEFAULT NULL            COMMENT '@手机号，多个用逗号分隔',
  `max_detail`              INT           NOT NULL DEFAULT 10     COMMENT '单条推送最多列出的明细条数',
  `repeat_after_hours`      INT           NOT NULL DEFAULT 0      COMMENT '同一笔（金额未变）多少小时后再提醒；0=只提醒一次',
  `quiet_hours`             VARCHAR(16)   DEFAULT NULL            COMMENT '免打扰时段，如 23:00-07:00（离线告警不受限）',
  `offline_alert_min`       INT           NOT NULL DEFAULT 20     COMMENT '超过 N 分钟没收到采集心跳→推离线告警（0=关闭）',
  `offline_alert_repeat_min` INT          NOT NULL DEFAULT 120    COMMENT '离线告警重复间隔（分钟）',
  `updated_by`              INT           DEFAULT NULL            COMMENT '最后修改人',
  `updated_at`              DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='美团毛利明细告警规则（每用户一行；采集在本机助手执行）';

-- ----------------------------------------------------------------------------
-- 表 7: profit_order_snapshot —— 毛利明细快照（助手每轮上报的最新值）
--   主键 (user_id, order_no)：同一订单只留最新一行（毛利变化时覆盖并更新 last_seen_at）。
--   用途：看板「毛利明细」、已推送去重的辅助依据、以及负毛利金额的变化轨迹（看 event 表）。
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `profit_order_snapshot` (
  `user_id`       INT UNSIGNED  NOT NULL                COMMENT '数据归属用户ID',
  `order_no`      VARCHAR(64)   NOT NULL                COMMENT '订单号（平台订单编号）',
  `store_name`    VARCHAR(255)  DEFAULT NULL            COMMENT '店铺名称',
  `goods_title`   VARCHAR(512)  DEFAULT NULL            COMMENT '商品名称',
  `order_status`  VARCHAR(64)   DEFAULT NULL            COMMENT '订单状态（已取消/已完成等）',
  `gross_profit`  DECIMAL(14,2) DEFAULT NULL            COMMENT '线上毛利（元，负数为亏损）',
  `amount`        DECIMAL(14,2) DEFAULT NULL            COMMENT '订单金额/实付（元，仅展示）',
  `order_time`    DATETIME      DEFAULT NULL            COMMENT '下单时间（页面能取到才填）',
  `remark`        VARCHAR(255)  DEFAULT NULL            COMMENT '备注/摘要（用于关键词排除）',
  `first_seen_at` DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '首次采集到的时间',
  `last_seen_at`  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '最近一次采集到的时间',
  PRIMARY KEY (`user_id`, `order_no`),
  KEY `idx_profit_snap_value` (`user_id`, `gross_profit`),
  KEY `idx_profit_snap_seen`  (`user_id`, `last_seen_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='美团毛利明细快照（本机助手采集上报；每单一行最新值）';

-- ----------------------------------------------------------------------------
-- 表 8: profit_alert_event —— 毛利告警事件（去重与审计）
--   去重指纹 fingerprint = sha1(订单号 + 毛利值)：同一笔同一金额只推一次；
--   毛利数值发生变化会算新事件（一条负毛利从 -8.2 变成 -15.6 值得再提醒一次）。
--   kind: neg=负毛利，recovered=已恢复，offline=采集端离线，test=测试推送
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `profit_alert_event` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`       INT UNSIGNED  NOT NULL                COMMENT '数据归属用户ID',
  `kind`          ENUM('neg','recovered','offline','test') NOT NULL DEFAULT 'neg' COMMENT '事件类型',
  `order_no`      VARCHAR(64)   NOT NULL DEFAULT ''     COMMENT '订单号（offline/test 为空）',
  `fingerprint`   CHAR(40)      NOT NULL                COMMENT '去重指纹 sha1(订单号+毛利值)',
  `store_name`    VARCHAR(255)  DEFAULT NULL            COMMENT '店铺名称（快照）',
  `goods_title`   VARCHAR(512)  DEFAULT NULL            COMMENT '商品名称（快照）',
  `order_status`  VARCHAR(64)   DEFAULT NULL            COMMENT '订单状态（快照）',
  `gross_profit`  DECIMAL(14,2) DEFAULT NULL            COMMENT '告警时的线上毛利',
  `amount`        DECIMAL(14,2) DEFAULT NULL            COMMENT '告警时的订单金额',
  `rule_threshold` DECIMAL(14,2) DEFAULT NULL           COMMENT '判定时使用的阈值',
  `channel`       VARCHAR(16)   NOT NULL DEFAULT 'wecom' COMMENT '推送渠道',
  `status`        ENUM('sent','pending','failed','skipped') NOT NULL DEFAULT 'pending'
                                                        COMMENT '推送状态：sent=已推送，pending=待推送（免打扰/未配置），failed=推送失败',
  `alerted_at`    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '告警时间',
  `recovered_at`  DATETIME      DEFAULT NULL            COMMENT '负毛利恢复时间（kind=neg 用）',
  `meta`          JSON          DEFAULT NULL            COMMENT '附加信息（推送结果、离线时长等）',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_profit_event_fp` (`user_id`, `fingerprint`),
  KEY `idx_profit_event_time` (`user_id`, `alerted_at`),
  KEY `idx_profit_event_kind` (`user_id`, `kind`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='毛利告警事件（指纹去重 + 推送审计）';

-- ----------------------------------------------------------------------------
-- 表 9: profit_collect_state —— 毛利采集心跳（每用户一行）
--   助手每轮采集都会上报；服务器据此判断「采集端是否还活着」，超时推离线告警。
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `profit_collect_state` (
  `user_id`       INT UNSIGNED  NOT NULL                COMMENT '数据归属用户ID',
  `last_report_at` DATETIME     DEFAULT NULL            COMMENT '最近一次上报时间（无论成功失败）',
  `last_ok_at`    DATETIME      DEFAULT NULL            COMMENT '最近一次成功采集时间',
  `ok`            TINYINT(1)    NOT NULL DEFAULT 0      COMMENT '最近一轮是否成功',
  `rows`          INT           NOT NULL DEFAULT 0      COMMENT '页面读到的原始行数',
  `parsed`        INT           NOT NULL DEFAULT 0      COMMENT '成功解析的订单数',
  `page_title`    VARCHAR(200)  DEFAULT NULL            COMMENT '页面标题（判断是否停在正确页面）',
  `page_url`      VARCHAR(500)  DEFAULT NULL            COMMENT '页面地址',
  `error`         VARCHAR(500)  DEFAULT NULL            COMMENT '最近一次错误（未登录/选择器失效等）',
  `agent_ver`     VARCHAR(32)   DEFAULT NULL            COMMENT '执行采集的助手版本',
  `target`        VARCHAR(120)  DEFAULT NULL            COMMENT '本机助手自报的采集目标（店铺/账号提示）',
  `mode`          VARCHAR(16)   DEFAULT NULL            COMMENT '采集模式：live=正式采集，dryrun=只看不推',
  `updated_at`    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='毛利采集心跳（用于离线告警与看板状态展示）';
