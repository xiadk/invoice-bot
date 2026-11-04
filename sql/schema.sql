-- ============================================================================
-- invoice-bot 数据库结构（MySQL / MariaDB 通用，字符集 utf8mb4）
--
-- 用法: mysql -h127.0.0.1 -P3306 -uroot -p < sql/schema.sql
--       或由 node import-to-db.js 自动执行（推荐，无需手工建库）
--
-- 全部表名、字段均带中文注释，便于直接在看板/客户端中理解含义。
-- 本文件使用 CREATE TABLE IF NOT EXISTS，重复执行不会删除已有数据。
--
-- ── 本文件只放「建表 / 建视图」语句 ──────────────────────────────────────
--   老库增量升级（补 user_id 列、调整唯一键与索引等）已统一收敛到 db.js 的
--   migrate()，那里用 information_schema 做守卫判断，MySQL 与 MariaDB 都能跑。
--   原因：ADD COLUMN/ADD KEY/DROP INDEX 的 IF NOT EXISTS 是 MariaDB 专有语法，
--   放在本文件里会让整份 schema.sql 在 MySQL 上执行失败（多语句一起中断）。
--   本文件被手工执行或由 ensureSchema() 执行一次即可，幂等性由上句保证。
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
  `username`             VARCHAR(64)   NOT NULL                COMMENT '登录账号（唯一；与公司全称解耦，v0.3.32 起不再要求等于公司名）',
  `password_hash`        VARCHAR(255)  NOT NULL                COMMENT '密码哈希（scrypt，格式 scrypt:盐:哈希）',
  `role`                 ENUM('admin','user') NOT NULL DEFAULT 'user' COMMENT '角色：admin=超级管理员，user=普通用户',
  `status`               ENUM('active','disabled') NOT NULL DEFAULT 'active' COMMENT '账号状态：active=正常，disabled=已禁用（禁用后无法登录，已登录会话立即失效）',
  `expires_at`           DATETIME      NULL DEFAULT NULL      COMMENT '使用到期时间（NULL=永久有效；超过后禁止登录与所有接口）',
  `company_full_name`    VARCHAR(255)  DEFAULT NULL            COMMENT '公司全称（v0.3.32；与登录账号分开，列表/选择/显示优先用它）',
  `company_name`         VARCHAR(255)  DEFAULT NULL            COMMENT '开票抬头：公司名称（催收消息 {companyName}；默认跟随公司全称）',
  `tax_no`               VARCHAR(64)   DEFAULT NULL            COMMENT '开票抬头：纳税人识别号（催收消息 {taxNo}）',
  `email`                VARCHAR(160)  DEFAULT NULL            COMMENT '开票抬头：收票邮箱（催收消息 {email}）',
  `display_name`         VARCHAR(64)   DEFAULT NULL            COMMENT '显示名（可选，看板右上角展示）',
  `note`                 VARCHAR(255)  DEFAULT NULL            COMMENT '备注（管理员填写，如所属业务线）',
  `brand_id`             INT           NOT NULL DEFAULT 1      COMMENT '所属品牌方（brand.id，默认 1=优购哆）',
  `owner_id`             INT           DEFAULT NULL            COMMENT '归属主体账号（员工号指向老板的 app_user.id；NULL=自主账号）',
  `qht_token`            VARCHAR(128)  DEFAULT NULL            COMMENT '齐货通接口登录态 x-token（用户自行粘贴，过期需重贴）',
  `qht_x_user`           VARCHAR(64)   DEFAULT NULL            COMMENT '齐货通接口登录态 x-user（一般是登录手机号）',
  `product_enabled`      TINYINT(1)    NOT NULL DEFAULT 0      COMMENT '是否允许查看商品列表页（含补货/齐货通；1=开启，超级管理员始终可见）',
  `after_sale_enabled`   TINYINT(1)    NOT NULL DEFAULT 0      COMMENT '是否允许查看售后管理页（1=开启，超级管理员始终可见）',
  `supplier_enabled`     TINYINT(1)    NOT NULL DEFAULT 0      COMMENT '是否允许查看供应商管理页（1=开启，超级管理员始终可见）',
  `waybill_enabled`      TINYINT(1)    NOT NULL DEFAULT 0      COMMENT '是否允许查看货单管理页（1=开启，超级管理员始终可见）',
  `replenish_order_enabled` TINYINT(1) NOT NULL DEFAULT 0      COMMENT '是否允许查看补货单管理页（1=开启，超级管理员始终可见；v0.3.12）',
  `staff_enabled`        TINYINT(1)    NOT NULL DEFAULT 0      COMMENT '是否允许查看员工管理页（1=开启，超级管理员走用户管理；v0.3.13）',
  `market_enabled`       TINYINT(1)    NOT NULL DEFAULT 0      COMMENT '是否允许查看交易市场页（1=开启，超级管理员始终可见）',
  `billing_enabled`      TINYINT(1)    NOT NULL DEFAULT 0      COMMENT '是否允许查看账单页（1=开启，超级管理员始终可见）',
  `token_version`        INT           NOT NULL DEFAULT 1      COMMENT '会话版本：改密/禁用时 +1，旧登录态立即失效',
  `must_change_password` TINYINT(1)    NOT NULL DEFAULT 0      COMMENT '是否强制下次登录修改密码',
  `created_by`           INT           DEFAULT NULL            COMMENT '创建者（管理员ID）',
  `last_login_at`        DATETIME      DEFAULT NULL            COMMENT '最近登录时间',
  `created_at`           DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at`           DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_app_user_username` (`username`),
  KEY `idx_app_user_role` (`role`),
  KEY `idx_app_user_brand` (`brand_id`),
  KEY `idx_app_user_owner` (`owner_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  COMMENT='账号表（多用户登录；role=admin 为超级管理员）';

-- ----------------------------------------------------------------------------
-- 表 0.1: brand —— 品牌方字典
--   一个代运营团队可能承运多个品牌方，每个品牌方有独立的牵牛花账号/门店仓。
--   同品牌方下的用户共用一套「品牌商品」数据（见 brand_product）。
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `brand` (
  `id`         INT           NOT NULL AUTO_INCREMENT COMMENT '品牌方ID',
  `name`       VARCHAR(64)   NOT NULL                COMMENT '品牌方名称',
  `status`     ENUM('active','disabled') NOT NULL DEFAULT 'active' COMMENT '状态：active=启用，disabled=停用',
  `note`       VARCHAR(255)  DEFAULT NULL            COMMENT '备注（如牵牛花登录账号）',
  `created_at` DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at` DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_brand_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  COMMENT='品牌方字典（商品数据按品牌方共享）';

INSERT IGNORE INTO `brand` (`id`, `name`, `note`) VALUES (1, '优购哆', '系统内置默认品牌方');

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
  KEY `idx_pay_time`       (`pay_time`),
  KEY `idx_user_seller_company` (`user_id`, `seller_company`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  COMMENT='1688完成订单表（源：data/users/<id>/完成订单/*.xlsx）';

-- 老库增量升级（补 user_id / 补索引）：见文件头说明，已交给 db.js migrate()

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
  KEY `idx_invoice_date`           (`invoice_date`),
  KEY `idx_user_seller_name`       (`user_id`, `seller_name`),
  KEY `idx_seller_invoice_date`    (`seller_name`, `invoice_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  COMMENT='历史已开票数据表（源：data/users/<id>/已开票订单/*.xlsx）';

-- 老库增量升级（补 user_id / uk_row_hash → uk_user_row_hash）：交给 db.js migrate()

-- ----------------------------------------------------------------------------
-- 表 3: seller_name_mapping —— 销方名称 ↔ 1688 商家名称 映射表（全员共享：tax_seller_name 全局唯一）
--   user_id 语义为「维护人」——记录这条映射最早由哪个用户建立；所有用户共用同一份映射关系
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `seller_name_mapping` (
  `id`              INT          NOT NULL AUTO_INCREMENT COMMENT '自增主键',
  `user_id`         INT          NOT NULL DEFAULT 1      COMMENT '维护人用户ID（谁建立的这条映射；映射全员共享，不做租户隔离）',
  `tax_seller_name` VARCHAR(255) NOT NULL                COMMENT '税务局销方名称（全局唯一，全员共享）',
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
  UNIQUE KEY `uk_tax_seller_name` (`tax_seller_name`),
  KEY `idx_user_id`             (`user_id`),
  KEY `idx_seller_login`        (`seller_login`),
  KEY `idx_seller_company`      (`seller_company`),
  KEY `idx_is_ignored`          (`is_ignored`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  COMMENT='税务局销方名称与1688商家名称的映射表（全员共享；is_ignored=1 表示确认无对应商家）';

-- 老库增量升级（user_id 语义改为维护人、唯一键改全局唯一）：交给 db.js migrate()

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

-- 老库增量升级（补 user_id / amount / order_nos / error 及索引）：交给 db.js migrate()

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

-- 老库增量升级（补 user_id 及索引）：交给 db.js migrate()

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
       ON m.`tax_seller_name` = i.`seller_name`
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
  `title_id`     INT UNSIGNED DEFAULT NULL
                 COMMENT '发送时选用的发票抬头（app_invoice_title.id；NULL=用账号上的老字段）',
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
-- operation_log —— 操作日志（记录所有用户在页面上的关键操作）
--   ⚠ 可见范围：仅超级管理员可在「操作日志」页查看，接口挂在 /api/admin/ 前缀下做 403 拦截。
--   隐私：content 为服务端渲染的中文一句话；detail 存结构化 JSON；不记录聊天正文等敏感内容。
--   ⚠ 注意：本表是**全局表**（不做 user_id 租户隔离），管理员需能跨用户查看，
--      因此不要把它加进 db.js 的 tenantTables 列表，也不要在查询里带 tenant 条件。
--   写入方式：logOp() 为旁路操作，写入失败只打日志、绝不抛错影响主流程。
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `operation_log` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`    INT UNSIGNED NOT NULL DEFAULT 0   COMMENT '操作人（app_user.id；0=匿名，如未登录访问下载页）',
  `username`   VARCHAR(64)  NOT NULL DEFAULT ''  COMMENT '操作人登录账号（冗余存储，列表免联表）',
  `action`     VARCHAR(32)  NOT NULL             COMMENT '操作类型（见服务端 OP_ACTIONS 白名单）',
  `content`    VARCHAR(512) NOT NULL DEFAULT ''  COMMENT '操作内容（面向人阅读的一句话）',
  `detail`     VARCHAR(2048) DEFAULT NULL        COMMENT '结构化明细（JSON），供排查用',
  `ip`         VARCHAR(64)  NOT NULL DEFAULT ''  COMMENT '来源 IP',
  `created_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '操作时间',
  PRIMARY KEY (`id`),
  KEY `idx_op_log_user`    (`user_id`),
  KEY `idx_op_log_username` (`username`),
  KEY `idx_op_log_action`  (`action`),
  KEY `idx_op_log_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='操作日志（仅超级管理员可查看）';

-- ----------------------------------------------------------------------------
-- brand_product —— 品牌商品主数据（「商品同步」写入；同品牌方全员共享）
--   一个品牌方一套商品，品牌内所有用户看到的是同一份数据（采购价/库存/在途/销量/状态/主图）。
--   数据源：牵牛花 前置仓补货参考（store-warehouse/page-query），字段映射见 lib/qnh.js。
--   唯一键 (brand_id, sku)：重复同步按品牌+SKU 覆盖更新。
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `brand_product` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `brand_id`        INT           NOT NULL              COMMENT '品牌方（brand.id）',
  `sku`             VARCHAR(64)   NOT NULL              COMMENT '商品SKU（= 牵牛花 goodsId）',
  `goods_name`      VARCHAR(512)  NOT NULL DEFAULT ''   COMMENT '商品名称（goodsName）',
  `image_url`       VARCHAR(512)  DEFAULT NULL          COMMENT '商品主图（picUrl）',
  `purchase_price`  DECIMAL(12,2) NOT NULL DEFAULT 0    COMMENT '采购价（purchasePrice）',
  `available_stock` INT           NOT NULL DEFAULT 0    COMMENT '可用库存（inStoreValidStockQty）',
  `transit_stock`   INT           NOT NULL DEFAULT 0    COMMENT '在途库存（inTransitQty）',
  `purchase_status` VARCHAR(32)   NOT NULL DEFAULT ''   COMMENT '采购状态（purchaseStatusDesc）',
  `purchase_status_code` TINYINT  NOT NULL DEFAULT 0    COMMENT '采购状态码（接口 purchaseStatuses：1=正常采购 2=已停采）',
  `sales_30d`       INT           NOT NULL DEFAULT 0    COMMENT '30天销量（sale30Num）',
  `qht_goods_id`    VARCHAR(64)   DEFAULT NULL          COMMENT '关联的齐货通商品ID（goodsId）',
  `afa_goods_id`    VARCHAR(64)   DEFAULT NULL          COMMENT '关联的城配速达商品ID（goodsId）',
  `jd_sku_id`       VARCHAR(64)   DEFAULT NULL          COMMENT '关联的京东万商 skuId（b.jd.com 商品ID）',
  `local_price`     DECIMAL(12,2) DEFAULT NULL          COMMENT '本地价（手工填写，仅作比价参考）',
  `local_spec_qty`  DECIMAL(12,2) DEFAULT NULL          COMMENT '本地价规格数量（一件含多少个基础单位；NULL=只填了单价）',
  `local_pack_price` DECIMAL(12,2) DEFAULT NULL         COMMENT '本地价整件价（= 单价 × 规格数量；规格为空时为 NULL）',
  `local_supplier_id` INT         NOT NULL DEFAULT 0     COMMENT '本地价供应商（supplier.id，0=未指定；v0.3.12）',
  `afa_match_score` SMALLINT      DEFAULT NULL          COMMENT '阿发自动匹配得分（0-100；手工关联留空）',
  `afa_match_at`    DATETIME      DEFAULT NULL          COMMENT '阿发自动匹配写入时间（非空=自动匹配结果）',
  `synced_at`       DATETIME      DEFAULT NULL          COMMENT '最近一次同步时间',
  `created_at`      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '首次同步时间',
  `updated_at`      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '最近更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_bp_brand_sku` (`brand_id`, `sku`),
  KEY `idx_bp_brand_status` (`brand_id`, `purchase_status`),
  KEY `idx_bp_brand_scode` (`brand_id`, `purchase_status_code`),
  KEY `idx_bp_afa` (`brand_id`, `afa_goods_id`),
  KEY `idx_bp_jd` (`brand_id`, `jd_sku_id`),
  KEY `idx_bp_sku` (`sku`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='品牌商品（商品同步写入；同品牌全员共享）';

-- ----------------------------------------------------------------------------
-- product_item —— 商品列表（前置仓补货参考批量导出导入；按用户隔离）
--   商品SKU 为 19 位长数字，按 VARCHAR 文本存储（禁止数值类型，防精度丢失）
--   重复导入按 (user_id, sku) 覆盖更新（与发票/订单导入同一惯例）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `product_item` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`         INT           NOT NULL              COMMENT '数据归属用户ID（app_user.id）',
  `brand_id`        INT           NOT NULL DEFAULT 1    COMMENT '导入者所属品牌方（brand.id）：仅用于按品牌商品补主图',
  `sku`             VARCHAR(64)   NOT NULL              COMMENT '商品SKU（文本存储）',
  `goods_name`      VARCHAR(512)  NOT NULL DEFAULT ''   COMMENT '商品名称',
  `image_url`       VARCHAR(512)  DEFAULT NULL          COMMENT '商品主图（按品牌商品补）',
  `purchase_price`  DECIMAL(12,2) NOT NULL DEFAULT 0    COMMENT '商品采购价（元，取「采购单价(基础单位)」）',
  `available_stock` INT           NOT NULL DEFAULT 0    COMMENT '可用库存（门店仓口径）',
  `transit_stock`   INT           NOT NULL DEFAULT 0    COMMENT '在途库存（门店仓口径）',
  `purchase_status` VARCHAR(16)   NOT NULL DEFAULT ''   COMMENT '采购状态（正常采购/停止采购，原样存导出文件的值）',
  `sales_30d`       INT           NOT NULL DEFAULT 0    COMMENT '30天总销量',
  `suggest_qty`     INT           NOT NULL DEFAULT 0    COMMENT '建议量（基础单位，来自补货参考文件的「建议量(基础单位)」列）',
  `qht_goods_id`    VARCHAR(64)   DEFAULT NULL          COMMENT '关联的齐货通商品ID（goodsId，用于实时取价与加购）',
  `afa_goods_id`    VARCHAR(64)   DEFAULT NULL          COMMENT '关联的城配速达商品ID（goodsId，用于实时取价与加购）',
  `jd_sku_id`       VARCHAR(64)   DEFAULT NULL          COMMENT '关联的京东万商 skuId（b.jd.com 商品ID，用于取万商价）',
  `local_price`    DECIMAL(12,2) DEFAULT NULL           COMMENT '本地价（手工填写并保存，仅作比价参考）',
  `local_spec_qty` DECIMAL(12,2) DEFAULT NULL           COMMENT '本地价规格数量（一件含多少个基础单位；NULL=只填了单价）',
  `local_pack_price` DECIMAL(12,2) DEFAULT NULL         COMMENT '本地价整件价（= 单价 × 规格数量；规格为空时为 NULL）',
  `local_supplier_id` INT         NOT NULL DEFAULT 0     COMMENT '本地价供应商（supplier.id，0=未指定；v0.3.12）',
  `batch_id`        BIGINT UNSIGNED NULL                COMMENT '最近一次导入批次（product_import_batch.id）',
  `source_file`     VARCHAR(255)  DEFAULT NULL          COMMENT '来源文件名',
  `created_at`      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '首次导入时间',
  `updated_at`      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '最近更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_user_sku` (`user_id`, `sku`),
  KEY `idx_pi_user_status` (`user_id`, `purchase_status`),
  KEY `idx_pi_brand` (`brand_id`),
  KEY `idx_pi_sku` (`sku`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='商品列表（前置仓补货参考导入；按用户隔离）';

-- ----------------------------------------------------------------------------
-- product_import_batch —— 商品导入批次快照（总货值趋势图的数据点）
--   总货值 = Σ((可用库存 + 在途库存) × 采购价)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `product_import_batch` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`     INT           NOT NULL              COMMENT '导入用户（app_user.id）',
  `source_file` VARCHAR(255)  NOT NULL DEFAULT ''   COMMENT '来源文件名',
  `item_count`  INT           NOT NULL DEFAULT 0    COMMENT '本次导入商品行数',
  `total_value` DECIMAL(14,2) NOT NULL DEFAULT 0    COMMENT '总货值=Σ((可用库存+在途库存)×采购价)',
  `imported_at` DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '导入时间',
  PRIMARY KEY (`id`),
  KEY `idx_pib_user_time` (`user_id`, `imported_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='商品导入批次快照（总货值趋势数据点）';

-- ----------------------------------------------------------------------------
-- market_listing —— 交易市场发布记录（⚠ 全局共享表：所有用户的报价在此汇集）
--   同人同 SKU 重复发布 = 更新价格/数量并刷新发布时间（唯一键 user_id+sku）
--   主列表按 sku GROUP BY 去重：数量=SUM(quantity)，价格=MIN(discount_price)
--   报价列表排序：价格升序、同价发布时间倒序（服务端 SQL 已排序）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `market_listing` (
  `id`             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`        INT           NOT NULL              COMMENT '发布人（app_user.id）',
  `sku`            VARCHAR(64)   NOT NULL              COMMENT '商品SKU',
  `goods_name`     VARCHAR(512)  NOT NULL DEFAULT ''   COMMENT '商品名称（发布时快照）',
  `orig_price`     DECIMAL(12,2) NOT NULL DEFAULT 0    COMMENT '发布时的商品采购价',
  `quantity`       INT           NOT NULL DEFAULT 0    COMMENT '发布数量（发布时可用库存快照）',
  `discount`       DECIMAL(6,2)  NOT NULL DEFAULT 100  COMMENT '折扣（百分比，80=按采购价80%）',
  `discount_price` DECIMAL(12,2) NOT NULL DEFAULT 0    COMMENT '折后价=采购价×折扣%',
  `published_at`   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '发布时间（重复发布即刷新）',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_ml_user_sku` (`user_id`, `sku`),
  KEY `idx_ml_sku` (`sku`),
  KEY `idx_ml_price` (`sku`, `discount_price`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='交易市场发布记录（跨用户共享，报价汇集）';

-- ----------------------------------------------------------------------------
-- billing_month —— 账单（按月统计收支）
--   一人一月一行（唯一键 user_id + month）；month 形如 '2026-10'
--   手工项：美团/淘宝/京东预计收入 + 房租/水电/人工/中心仓/配送费/推广费/自采酒水/雪糕/果蔬/
--           增值税/企业所得税/其它
--   自动项（不落库，每次由业务表实时聚合）：
--     1688 订单当月总金额 = SUM(invoice_order.pay_amount) 按 pay_time 归月（空则 created_at）
--     拼多多当月实付     = SUM(pdd_order.pay_amount)    按 order_time 归月
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `billing_month` (
  `user_id`        INT           NOT NULL DEFAULT 1     COMMENT '数据归属用户（app_user.id）',
  `month`          CHAR(7)       NOT NULL               COMMENT '账期月份 YYYY-MM',
  `income_meituan` DECIMAL(14,2) NOT NULL DEFAULT 0     COMMENT '收入：美团预计收入（手工）',
  `income_taobao`  DECIMAL(14,2) NOT NULL DEFAULT 0     COMMENT '收入：淘宝预计收入（手工）',
  `income_jd`      DECIMAL(14,2) NOT NULL DEFAULT 0     COMMENT '收入：京东预计收入（手工）',
  `exp_rent`       DECIMAL(14,2) NOT NULL DEFAULT 0     COMMENT '支出：房租（手工）',
  `exp_utility`    DECIMAL(14,2) NOT NULL DEFAULT 0     COMMENT '支出：水电（手工）',
  `exp_labor`      DECIMAL(14,2) NOT NULL DEFAULT 0     COMMENT '支出：人工（手工）',
  `exp_warehouse`  DECIMAL(14,2) NOT NULL DEFAULT 0     COMMENT '支出：中心仓（v0.3.8 起停用，保留历史值；采购改由供应商货单项统计）',
  `exp_delivery`   DECIMAL(14,2) NOT NULL DEFAULT 0     COMMENT '支出：配送费（手工）',
  `exp_promo`      DECIMAL(14,2) NOT NULL DEFAULT 0     COMMENT '支出：推广费（手工）',
  `exp_liquor`     DECIMAL(14,2) NOT NULL DEFAULT 0     COMMENT '支出：自采酒水（v0.3.8 起停用，保留历史值）',
  `exp_ice`        DECIMAL(14,2) NOT NULL DEFAULT 0     COMMENT '支出：雪糕（v0.3.8 起停用，保留历史值）',
  `exp_produce`    DECIMAL(14,2) NOT NULL DEFAULT 0     COMMENT '支出：果蔬（v0.3.8 起停用，保留历史值）',
  `exp_vat`        DECIMAL(14,2) NOT NULL DEFAULT 0     COMMENT '支出：增值税（手工）',
  `exp_cit`        DECIMAL(14,2) NOT NULL DEFAULT 0     COMMENT '支出：企业所得税（手工）',
  `exp_other`      DECIMAL(14,2) NOT NULL DEFAULT 0     COMMENT '支出：其它（手工）',
  `note`           VARCHAR(255)  DEFAULT NULL           COMMENT '备注',
  `created_at`     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at`     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`user_id`, `month`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='账单（按月收支；1688/拼多多金额实时统计不落库）';

-- ----------------------------------------------------------------------------
-- goods_price_cache —— 平台商品价格缓存（齐货通 / 城配速达）
--   需求：取过一次价就持久化，页面查询优先读库，只有点「重新取价」才去平台拉新。
--   唯一键 (kind, brand_id, goods_id)：按品牌方共用一份（不同品牌方的协议价可能不同）。
--   永久有效，不设过期；价格变化靠页面上的「强制刷新（重新取价）」更新。
--   整件价口径：齐货通 pack_price = saleIP、阿发 pack_price = salesPrice；
--   pack_qty 口径：齐货通 = packingSpecification（一件多少瓶/罐）、阿发 = unitFactor。
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `goods_price_cache` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `kind`        VARCHAR(8)    NOT NULL              COMMENT '价格来源：qht=齐货通 / afa=城配速达',
  `brand_id`    INT           NOT NULL DEFAULT 0    COMMENT '品牌方（brand.id）：同品牌共用一份',
  `goods_id`    VARCHAR(64)   NOT NULL              COMMENT '平台商品ID（齐货通/阿发 goodsId）',
  `goods_name`  VARCHAR(512)  NOT NULL DEFAULT ''   COMMENT '商品名称（取价时的快照）',
  `unit_price`  DECIMAL(12,4) DEFAULT NULL          COMMENT '折合小单位单价（qht=saleIP÷规格 / afa=salesPrice÷unitFactor）',
  `pack_price`  DECIMAL(12,2) DEFAULT NULL          COMMENT '整件价（qht=saleIP / afa=salesPrice）',
  `pack_qty`    DECIMAL(12,2) DEFAULT NULL          COMMENT '一件含多少小单位（qht=packingSpecification / afa=unitFactor）',
  `spec`        VARCHAR(64)   DEFAULT NULL          COMMENT '规格文案（qht=packingSpecification+smallUnit / afa=factorName）',
  `small_unit`  VARCHAR(16)   DEFAULT NULL          COMMENT '小单位（瓶/罐/支，仅齐货通有）',
  `picture`     VARCHAR(512)  DEFAULT NULL          COMMENT '平台商品图',
  `raw_json`    MEDIUMTEXT    DEFAULT NULL          COMMENT '上游原始返回（排查用，非页面依赖）',
  `fetched_at`  DATETIME      NOT NULL              COMMENT '取价时间（页面显示「缓存于 …」）',
  `updated_at`  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '最近写入时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_pc_scope` (`kind`, `brand_id`, `goods_id`),
  KEY `idx_pc_goods` (`kind`, `goods_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='平台商品价格缓存（取一次即持久化，按品牌方共用）';

-- ----------------------------------------------------------------------------
-- 表 5.3b: product_price_manual —— 商品手工价（v0.3.28）
--   平台取到的价错了（或没关联到平台商品）时，允许人工填一份齐货通价：
--   单价 / 整件价 / 规格，按「品牌方 + SKU + 来源」唯一，**优先级高于 goods_price_cache**。
--   比价分析与补货单都按这份手工价算；页面用「手工」标签明示，避免看不出是人填的。
--   kind 目前只放行 qht（阿发/京东暂不做），字段留通用以便以后扩展。
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `product_price_manual` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `brand_id`    INT           NOT NULL DEFAULT 0    COMMENT '品牌方（brand.id）：同品牌共用一份',
  `sku`         VARCHAR(64)   NOT NULL              COMMENT '商品SKU',
  `kind`        VARCHAR(8)    NOT NULL DEFAULT 'qht' COMMENT '价格来源：qht=齐货通（暂时只有这一种）',
  `goods_name`  VARCHAR(512)  NOT NULL DEFAULT ''   COMMENT '商品名称快照（改价时带出，便于核对）',
  `unit_price`  DECIMAL(12,4) DEFAULT NULL          COMMENT '手工单价（折合小单位，元）',
  `pack_price`  DECIMAL(12,2) DEFAULT NULL          COMMENT '手工整件价（元/件）',
  `pack_qty`    DECIMAL(12,2) DEFAULT NULL          COMMENT '一件含多少小单位（规格数量）',
  `spec`        VARCHAR(64)   DEFAULT NULL          COMMENT '规格文案（没有规格数量时直接显示它）',
  `small_unit`  VARCHAR(16)   DEFAULT NULL          COMMENT '小单位（瓶/罐/支）',
  `note`        VARCHAR(255)  DEFAULT NULL          COMMENT '改价原因（备注）',
  `updated_by`  VARCHAR(64)   DEFAULT NULL          COMMENT '最后改价人（登录账号）',
  `created_at`  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '首次填写时间',
  `updated_at`  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_ppm_scope` (`brand_id`, `sku`, `kind`),
  KEY `idx_ppm_kind` (`kind`, `brand_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='商品手工价（人工覆盖平台取价，比价与补货单优先用它）';

-- ----------------------------------------------------------------------------
-- 售后管理（牵牛花模块）
--   ⚠ 其余 qnh_* 表（退单、明细、日志、同步批次、毛利等）历来由 db.js 的
--     ensureQnhSchema() 建，这里是 v0.2.108 起补上的两张售后表，保证全新部署
--     按本文件建库也能一次建对。两份 DDL 必须保持一致，改动时同步 db.js。
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `qnh_after_manual` (
  `id`           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`      INT           NOT NULL DEFAULT 1   COMMENT '数据归属用户（员工录入时是所属主体账号）',
  `sku`          VARCHAR(64)   NOT NULL DEFAULT ''  COMMENT '商品SKU（从商品列表搜索选中）',
  `goods_name`   VARCHAR(512)  NOT NULL DEFAULT ''  COMMENT '商品名称（选中后可手改，兼容搜不到的商品）',
  `image_url`    VARCHAR(512)  DEFAULT NULL         COMMENT '商品主图（选中商品时带上，仅展示用）',
  `qty`          INT           NOT NULL DEFAULT 1   COMMENT '售后数量',
  `apply_reason` VARCHAR(512)  DEFAULT NULL         COMMENT '售后原因（人工填写）',
  `status`       TINYINT       NOT NULL DEFAULT 0   COMMENT '售后处理状态：0待处理 1已申请 2已退货 3已退款',
  `note`         VARCHAR(255)  DEFAULT NULL         COMMENT '处理备注',
  `handled_by`   VARCHAR(64)   DEFAULT NULL         COMMENT '最后处理人',
  `handled_at`   DATETIME      DEFAULT NULL         COMMENT '最后处理时间',
  `created_by`   VARCHAR(64)   DEFAULT NULL         COMMENT '录入人',
  `created_at`   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_qam_user_time`   (`user_id`, `created_at`),
  KEY `idx_qam_user_status` (`user_id`, `status`),
  KEY `idx_qam_sku`         (`user_id`, `sku`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='手工登记的售后（售后管理页「新增售后」）';

CREATE TABLE IF NOT EXISTS `qnh_after_attach` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`     INT           NOT NULL DEFAULT 1   COMMENT '数据归属用户（员工操作时记所属主体账号）',
  `row_key`     VARCHAR(64)   NOT NULL             COMMENT '售后行键：pa:<商品售后id> / ref:<退单号> / man:<手工售后id>',
  `status`      TINYINT       NOT NULL DEFAULT 0   COMMENT '本次变更后的处理状态：0待处理 1已申请 2已退货 3已退款',
  `object_key`  VARCHAR(512)  NOT NULL             COMMENT '七牛对象 key（不含域名，展示时签名）',
  `mime`        VARCHAR(64)   DEFAULT NULL         COMMENT '图片类型（image/png 等）',
  `size`        INT UNSIGNED  DEFAULT NULL         COMMENT '图片字节数',
  `note`        VARCHAR(255)  DEFAULT NULL         COMMENT '本次变更的备注（冗余一份，附件单独看也能读到）',
  `created_by`  VARCHAR(64)   DEFAULT NULL         COMMENT '操作人',
  `created_at`  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_qaa_row`  (`user_id`, `row_key`, `created_at`),
  KEY `idx_qaa_time` (`user_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='售后凭证图片（每次状态变更一张，存七牛 key）';

-- ----------------------------------------------------------------------------
-- 表 5: supplier —— 供应商字典（供应商管理页，v0.3.0）
--   本系统自己维护，不连任何平台；按账号隔离（员工录入归属所属主体账号）。
--   同名供应商在同一账号下只允许一条，避免建货单时下拉里出现两个一样的名字。
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `supplier` (
  `id`         INT           NOT NULL AUTO_INCREMENT,
  `user_id`    INT           NOT NULL DEFAULT 1   COMMENT '数据归属用户（员工录入时是所属主体账号）',
  `name`       VARCHAR(64)   NOT NULL             COMMENT '供应商名称（同账号下唯一）',
  `note`       VARCHAR(255)  DEFAULT NULL         COMMENT '备注（联系方式、结算方式等）',
  `created_by` VARCHAR(64)   DEFAULT NULL         COMMENT '录入人（登录账号）',
  `created_at` DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '新建日期',
  `updated_at` DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_supplier_user_name` (`user_id`, `name`),
  KEY `idx_supplier_user` (`user_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='供应商字典（供应商管理页维护，货单引用）';

-- ----------------------------------------------------------------------------
-- 表 5.1: waybill —— 货单（采购台账，v0.3.0）
--   supplier_name 是建单时的名称快照：供应商被改名后展示仍取当前名（JOIN），
--   万一供应商行没了才回落到快照，不至于列表里出现空白供应商。
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `waybill` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`       INT           NOT NULL DEFAULT 1   COMMENT '数据归属用户（员工录入时是所属主体账号）',
  `supplier_id`   INT           NOT NULL DEFAULT 0   COMMENT '供应商（supplier.id）',
  `supplier_name` VARCHAR(64)   NOT NULL DEFAULT ''  COMMENT '建单时的供应商名称快照（供应商被删时兜底展示）',
  `amount`        DECIMAL(12,2) NOT NULL DEFAULT 0.00 COMMENT '货单金额（元）',
  `bill_date`     DATE          NOT NULL             COMMENT '货单日期（按此列查询与排序）',
  `invoice_status` TINYINT      NOT NULL DEFAULT 0   COMMENT '开票状态：0未开票 1已开票（v0.3.6）',
  `note`          VARCHAR(255)  DEFAULT NULL         COMMENT '备注（列表不再展示；历史导入时用来记原始行来源）',
  `created_by`    VARCHAR(64)   DEFAULT NULL         COMMENT '录入人（登录账号）',
  `created_at`    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '新建日期',
  `deleted_at`    DATETIME      DEFAULT NULL         COMMENT '软删除时间（NULL=有效；删除只在库里打标记，列表/统计一律过滤）',
  `updated_at`    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_waybill_user_date`  (`user_id`, `bill_date`),
  KEY `idx_waybill_user_sup`   (`user_id`, `supplier_id`),
  KEY `idx_waybill_user_ctime` (`user_id`, `created_at`),
  KEY `idx_waybill_alive`      (`user_id`, `deleted_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='货单（供应商 + 金额 + 货单日期 + 图片）';

-- ----------------------------------------------------------------------------
-- 表 5.2: waybill_image —— 货单图片（v0.3.0）
--   只存七牛对象 key，展示时现签临时链接；waybill_id=0 表示「手机刚传上来、还没绑到货单」，
--   靠 token 关联到那次新建操作（见 waybill_upload_token）。
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `waybill_image` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`    INT           NOT NULL DEFAULT 1   COMMENT '数据归属用户（员工操作时记所属主体账号）',
  `waybill_id` BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '所属货单（0=还没绑定，等电脑端点保存）',
  `token`      CHAR(32)      DEFAULT NULL         COMMENT '上传时用的临时令牌（绑定后清空）',
  `object_key` VARCHAR(512)  NOT NULL             COMMENT '七牛对象 key（不含域名，展示时签名）',
  `mime`       VARCHAR(64)   DEFAULT NULL         COMMENT '图片类型（image/jpeg 等）',
  `size`       INT UNSIGNED  DEFAULT NULL         COMMENT '图片字节数',
  `sort`       INT           NOT NULL DEFAULT 0   COMMENT '同单内展示顺序（绑定前是 0..n，绑定时改为自增 id）',
  `created_at` DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_wi_waybill` (`waybill_id`, `user_id`, `sort`),
  KEY `idx_wi_token`   (`token`, `user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='货单图片（存七牛 key；waybill_id=0 为待绑定）';

-- ----------------------------------------------------------------------------
-- 表 5.3: waybill_upload_token —— 手机扫码上传的临时凭证（v0.3.0）
--   电脑端点「生成手机上传链接」写一行，5 分钟后失效；只能传图，不能读任何已有数据。
--   过期 1 天的行会被下一次生成链接时顺手清掉。
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `waybill_upload_token` (
  `token`      CHAR(32)      NOT NULL             COMMENT '32 位十六进制随机串（URL 里带 ?t=）',
  `user_id`    INT           NOT NULL DEFAULT 1   COMMENT '图片归属用户（= 生成链接的人所属主体）',
  `created_by` VARCHAR(64)   DEFAULT NULL         COMMENT '生成链接的人（登录账号）',
  `expires_at` DATETIME      NOT NULL             COMMENT '失效时间（NOW()+5 分钟）',
  `used_count` INT           NOT NULL DEFAULT 0   COMMENT '已成功上传张数（仅统计，上限看配置）',
  `created_at` DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`token`),
  KEY `idx_wut_expire` (`expires_at`),
  KEY `idx_wut_user`   (`user_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='货单图片的手机上传临时令牌（5 分钟有效）';

-- ----------------------------------------------------------------------------
-- 表 5.4: product_after —— 商品售后台账（v0.3.25）
--   售后菜单整页换成「商品售后」：主体是商品（名称 + SKU + 数量 + 原因），不再挂供应商/金额。
--   状态四档人工变更：0 待处理 → 1 已申请 → 2 已退货（必填运单号）→ 3 已退款（必传退款截图）。
--   凭证图复用 qnh_after_attach（row_key 用 pa:<id>）：status=0 商品实物图，status=3 退款截图。
--   旧 supplier_after 已停用，清理脚本见 sql/upgrade/0.3.25-商品售后.sql。
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `product_after` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`       INT           NOT NULL DEFAULT 1   COMMENT '数据归属用户（员工录入时是所属主体账号）',
  `goods_name`    VARCHAR(255)  NOT NULL DEFAULT ''  COMMENT '商品名称（选中商品自动回填，可手改）',
  `sku`           VARCHAR(64)   NOT NULL DEFAULT ''  COMMENT '商品 SKU',
  `qty`           INT           NOT NULL DEFAULT 1   COMMENT '售后数量（件）',
  `after_reason`  VARCHAR(255)  DEFAULT NULL         COMMENT '售后原因',
  `after_date`    DATE          NOT NULL             COMMENT '售后日期（按此列查询与排序）',
  `status`        TINYINT       NOT NULL DEFAULT 0   COMMENT '处理状态：0待处理 1已申请 2已退货 3已退款（人工变更）',
  `waybill_no`    VARCHAR(64)   DEFAULT NULL         COMMENT '退货运单号（状态改到「已退货」时必填）',
  `note`          VARCHAR(255)  DEFAULT NULL         COMMENT '备注',
  `handled_by`    VARCHAR(64)   DEFAULT NULL         COMMENT '最后处理人（登录账号）',
  `handled_at`    DATETIME      DEFAULT NULL         COMMENT '最后处理时间',
  `created_by`    VARCHAR(64)   DEFAULT NULL         COMMENT '录入人（登录账号）',
  `created_at`    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '新建日期',
  `updated_at`    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_pa_user_date`   (`user_id`, `after_date`),
  KEY `idx_pa_user_sku`    (`user_id`, `sku`),
  KEY `idx_pa_user_status` (`user_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='商品售后台账（商品名称/SKU + 数量 + 原因 + 状态 + 运单号 + 凭证）';

-- ----------------------------------------------------------------------------
-- 表 5.5: qht_order —— 齐货通订单（v0.3.3）
--   「我的 → 全部订单」接口 /mall/api/goods/orders/myPage 拉回落库，按 user_id + order_no upsert。
--   账单支出项「齐货通当月订单金额」从这里实时聚合：
--     排除口径（用户确认）：status_name 含「取消/关闭」的不算；未支付（pay_status≠1 且 pay_flag=0）不算。
--   口径集中在 lib/billing.js，别在这里加 WHERE。
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `qht_order` (
  `id`             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`        INT           NOT NULL               COMMENT '数据归属用户（齐货通登录态所属账号）',
  `order_no`       VARCHAR(32)   NOT NULL               COMMENT '订单编号（DD 开头）',
  `status`         TINYINT       NOT NULL DEFAULT 0     COMMENT '平台状态码',
  `status_name`    VARCHAR(32)   NOT NULL DEFAULT ''    COMMENT '平台状态名（已发货/已取消/已完成…）',
  `pay_flag`       TINYINT       NOT NULL DEFAULT 0     COMMENT '支付标记：0未支付 1线下部分结款 2线下全部结款',
  `pay_status`     TINYINT       NOT NULL DEFAULT 0     COMMENT '支付状态码（1=已支付，平台语义）',
  `pay_status_name` VARCHAR(32)  NOT NULL DEFAULT ''    COMMENT '支付状态名（已支付/未支付…）',
  `store_name`     VARCHAR(64)   NOT NULL DEFAULT ''    COMMENT '发货仓库',
  `sale_no`        VARCHAR(32)   NOT NULL DEFAULT ''    COMMENT '出货单号（XS 开头，部分状态才有）',
  `ipcnt`          INT           NOT NULL DEFAULT 0     COMMENT '件数',
  `spcnt`          INT           NOT NULL DEFAULT 0     COMMENT '散数',
  `payable_money`  DECIMAL(12,2) NOT NULL DEFAULT 0.00  COMMENT '实付款（元）',
  `order_time`     DATETIME      NOT NULL               COMMENT '下单时间（按此列归月）',
  `created_at`     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '首次拉取时间',
  `updated_at`     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_qo_user_no`  (`user_id`, `order_no`),
  KEY `idx_qo_user_time`      (`user_id`, `order_time`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='齐货通订单（账单支出项「齐货通当月订单金额」数据源）';

-- ----------------------------------------------------------------------------
-- 表 5.6: replenish_order —— 补货单（v0.3.12）
--   「采用补货建议」时按供应商归集生成：一个供应商一张单，金额 = 各明细行总额之和。
--   明细行口径：补货数量(件) = 向上取整(建议量 ÷ 规格)，行总额 = 补货数量 × 规格 × 最低单价。
--   waybill_id/waybill_amount 是「关联货单」的结果快照：货单被软删或改金额后，
--   补货单页仍能显示当时对账用的金额（对比结论不会突然变成 0）。
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `replenish_order` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`       INT           NOT NULL DEFAULT 1   COMMENT '数据归属用户（员工操作时记所属主体账号）',
  `supplier_id`   INT           NOT NULL DEFAULT 0   COMMENT '供应商（supplier.id；0=本地价没指定供应商）',
  `supplier_name` VARCHAR(64)   NOT NULL DEFAULT ''  COMMENT '生成时的供应商名称快照',
  `channel`       VARCHAR(8)    NOT NULL DEFAULT ''  COMMENT '主要渠道：local/qht/afa/jd/mixed（明细行各有自己的渠道）',
  `amount`        DECIMAL(12,2) NOT NULL DEFAULT 0.00 COMMENT '补货单金额（明细行总额之和）',
  `item_count`    INT           NOT NULL DEFAULT 0   COMMENT '商品行数',
  `qty_total`     INT           NOT NULL DEFAULT 0   COMMENT '补货数量合计（件）',
  `batch_id`      VARCHAR(64)   DEFAULT NULL         COMMENT '来源补货文件批次（product_import_batch.id）',
  `waybill_id`    BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '关联的货单（waybill.id，0=未关联）',
  `waybill_amount` DECIMAL(12,2) DEFAULT NULL        COMMENT '关联时的货单金额快照（用于列表对比）',
  `linked_at`     DATETIME      DEFAULT NULL         COMMENT '关联时间',
  `created_by`    VARCHAR(64)   DEFAULT NULL         COMMENT '生成人（登录账号）',
  `created_at`    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '生成日期',
  `deleted_at`    DATETIME      DEFAULT NULL         COMMENT '软删除时间（NULL=有效）',
  `updated_at`    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_ro_user_time` (`user_id`, `created_at`),
  KEY `idx_ro_user_sup`  (`user_id`, `supplier_id`),
  KEY `idx_ro_alive`     (`user_id`, `deleted_at`),
  KEY `idx_ro_waybill`   (`waybill_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='补货单（采用补货建议生成，按供应商归集）';

-- ----------------------------------------------------------------------------
-- 表 5.7: replenish_order_item —— 补货单明细（v0.3.12）
--   一行 = 一个 SKU 在某个渠道上的补货建议。suggest_qty/spec_qty 都存下来，
--   是为了事后能复核「当初为什么算成这个件数」，不依赖商品表当前值（会被重新导入覆盖）。
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `replenish_order_item` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `order_id`      BIGINT UNSIGNED NOT NULL           COMMENT '所属补货单（replenish_order.id）',
  `user_id`       INT           NOT NULL DEFAULT 1   COMMENT '数据归属用户',
  `sku`           VARCHAR(64)   NOT NULL             COMMENT '商品SKU',
  `goods_name`    VARCHAR(512)  NOT NULL DEFAULT ''  COMMENT '生成时的商品名称快照',
  `channel`       VARCHAR(8)    NOT NULL DEFAULT ''  COMMENT '价源：local/qht/afa/jd',
  `channel_label` VARCHAR(32)   NOT NULL DEFAULT ''  COMMENT '价源显示名（齐货通/永源顺/京东万商/供应商名）',
  `supplier_id`   INT           NOT NULL DEFAULT 0   COMMENT '该行的供应商（supplier.id，0=未指定）',
  `suggest_qty`   DECIMAL(12,2) NOT NULL DEFAULT 0.00 COMMENT '建议量（基础单位，可被用户改过）',
  `spec_qty`      DECIMAL(12,2) NOT NULL DEFAULT 1.00 COMMENT '规格（一件含多少基础单位；无规格按 1）',
  `qty_pack`      INT           NOT NULL DEFAULT 0   COMMENT '补货数量（件）= 向上取整(建议量 ÷ 规格)',
  `unit_price`    DECIMAL(12,4) NOT NULL DEFAULT 0.0000 COMMENT '最低单价（元/基础单位）',
  `pack_price`    DECIMAL(12,2) DEFAULT NULL         COMMENT '整件价（单价 × 规格）',
  `amount`        DECIMAL(12,2) NOT NULL DEFAULT 0.00 COMMENT '行总额（补货数量 × 规格 × 单价）',
  `created_at`    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_roi_order` (`order_id`, `user_id`),
  KEY `idx_roi_sku`   (`user_id`, `sku`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='补货单明细（每个 SKU 一行，含价源与折算依据）';
