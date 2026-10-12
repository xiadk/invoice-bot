-- ============================================================================
-- invoice-bot 数据库结构（MySQL / MariaDB 通用，字符集 utf8mb4）
--
-- 用法: mysql -h127.0.0.1 -P3306 -uroot -p < sql/schema.sql
--       或由 node import-to-db.js 自动执行（推荐，无需手工建库）
--
-- 全部表名、字段均带中文注释，便于直接在看板/客户端中理解含义。
-- 本文件使用 CREATE TABLE IF NOT EXISTS，重复执行不会删除已有数据。
-- ============================================================================

CREATE DATABASE IF NOT EXISTS `invoice_bot`
  DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;

USE `invoice_bot`;

-- ----------------------------------------------------------------------------
-- 表 1: invoice_order —— 1688 完成订单表
--   数据来源: data/完成订单/*.xlsx（1688「已买到的货品」后台导出）
--   看板口径: 订单数 / 订单金额 / 待开票金额 / 催收名单
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `invoice_order` (
  `order_no`          VARCHAR(32)   NOT NULL                COMMENT '订单编号（1688订单号，主键；多SKU续行已按主行去重）',
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
  `source_file`       VARCHAR(160)  DEFAULT NULL            COMMENT '数据来源文件名（data/完成订单/xxx.xlsx）',
  `invoice_state`     ENUM('none','applying','issued') NOT NULL DEFAULT 'none'
                                                            COMMENT '订单级开票状态（有效状态）：none=未申请，applying=已申请，issued=已开票',
  `state_source`      ENUM('platform','manual') NOT NULL DEFAULT 'platform'
                                                            COMMENT '开票状态来源：platform=平台刷新（refresh-status.js），manual=人工确认（商家线下已开票）',
  `state_updated_at`  DATETIME      DEFAULT NULL            COMMENT '开票状态最后更新时间',
  `state_note`        VARCHAR(255)  DEFAULT NULL            COMMENT '开票状态备注（人工确认时的说明）',
  `imported_at`       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '入库时间',
  PRIMARY KEY (`order_no`),
  KEY `idx_seller_login`   (`seller_login`),
  KEY `idx_seller_company` (`seller_company`),
  KEY `idx_invoice_state`  (`invoice_state`),
  KEY `idx_pay_time`       (`pay_time`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  COMMENT='1688完成订单表（源：data/完成订单/*.xlsx）';

-- ----------------------------------------------------------------------------
-- 表 2: issued_invoice —— 历史已开票数据表（税务局全量发票导出）
--   数据来源: data/已开票订单/*.xlsx（电子税务局「全量发票查询」导出）
--   说明: 一行 = 一张发票的一个明细行；数电票以 e_invoice_no 标识发票。
--         seller_name 是税务局口径的销方名称，与订单里的商家名称不一致，
--         需通过 seller_name_mapping 映射后写入 seller_company 供统计使用。
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `issued_invoice` (
  `id`                BIGINT        NOT NULL AUTO_INCREMENT COMMENT '自增主键',
  `row_hash`          CHAR(40)      NOT NULL                COMMENT '行指纹（md5，用于重复导入自动去重）',
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
  `source_file`       VARCHAR(160)  DEFAULT NULL            COMMENT '来源文件名（data/已开票订单/xxx.xlsx）',
  `imported_at`       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '入库时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_row_hash`         (`row_hash`),
  KEY `idx_e_invoice_no`           (`e_invoice_no`),
  KEY `idx_seller_name`            (`seller_name`),
  KEY `idx_seller_company`         (`seller_company`),
  KEY `idx_invoice_date`           (`invoice_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  COMMENT='历史已开票数据表（源：data/已开票订单/*.xlsx，税务局全量发票导出）';

-- ----------------------------------------------------------------------------
-- 表 3: seller_name_mapping —— 销方名称 ↔ 1688 商家名称 映射表
--   税务局销方名称与订单里的商家名称不一致，自动匹配不上的由人工在
--   看板「名称映射」页维护；后续统计一律通过本表建立名称关系。
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `seller_name_mapping` (
  `id`              INT          NOT NULL AUTO_INCREMENT COMMENT '自增主键',
  `tax_seller_name` VARCHAR(255) NOT NULL                COMMENT '税务局销方名称（唯一键，被映射的一方）',
  `seller_company`  VARCHAR(255) NULL                    COMMENT '对应的1688卖家公司名',
  `seller_login`    VARCHAR(128) NULL                    COMMENT '对应的1688卖家会员名（登录ID）',
  `match_type`      VARCHAR(16)  NOT NULL DEFAULT 'manual' COMMENT '匹配方式：auto=系统自动匹配，manual=人工维护',
  `match_rule`      VARCHAR(64)  DEFAULT NULL            COMMENT '自动匹配命中的规则（exact / normalized / contains / login / remark）',
  `is_confirmed`    TINYINT(1)   NOT NULL DEFAULT 0      COMMENT '是否人工确认：0=自动匹配待人工复核，1=已确认',
  `is_ignored`      TINYINT(1)   NOT NULL DEFAULT 0      COMMENT '是否忽略：1=该销方名称确认无对应1688商家，从待比对列表与统计中剔除（可在名称映射页恢复）',
  `note`            VARCHAR(255) DEFAULT NULL            COMMENT '备注',
  `created_at`      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at`      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_tax_seller_name` (`tax_seller_name`),
  KEY `idx_seller_login`          (`seller_login`),
  KEY `idx_seller_company`        (`seller_company`),
  KEY `idx_is_ignored`            (`is_ignored`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  COMMENT='税务局销方名称与1688商家名称的映射表（人工可比对维护；is_ignored=1 表示确认无对应商家）';

-- 老库增量补列（新装库上面的 CREATE TABLE 已含该列；MariaDB 支持 IF NOT EXISTS）
--   is_ignored = 1：人工确认该税务局销方名称没有对应的 1688 商家，从待比对列表与统计中剔除
ALTER TABLE `seller_name_mapping`
  ADD COLUMN IF NOT EXISTS `is_ignored` TINYINT(1) NOT NULL DEFAULT 0
  COMMENT '是否忽略：1=该销方名称确认无对应1688商家，从待比对列表与统计中剔除（可在名称映射页恢复）'
  AFTER `is_confirmed`;

-- ----------------------------------------------------------------------------
-- 表 4: send_log —— 催收消息发送记录（替代原 data/sent-log.json）
--   一行 = 一次催收发送（不再按天合并），看板由此表统计
--   「催收次数」= COUNT(*)、「最近催收时间」= MAX(sent_at)。
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `send_log` (
  `id`             INT          NOT NULL AUTO_INCREMENT COMMENT '自增主键',
  `send_date`      DATE         NOT NULL                COMMENT '发送日期（用于按天统计/每日限额）',
  `seller_login`   VARCHAR(128) NOT NULL                COMMENT '卖家会员名（1688登录ID）',
  `seller_company` VARCHAR(255) DEFAULT NULL            COMMENT '卖家公司名（冗余，便于直接查看）',
  `result`         VARCHAR(16)  NOT NULL DEFAULT 'ok'   COMMENT '发送结果：ok=成功，fail=失败',
  `channel`        VARCHAR(16)  NOT NULL DEFAULT 'web'  COMMENT '发送入口：web=看板，cli=命令行',
  `sent_at`        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '发送时间（最近催收时间取 MAX）',
  PRIMARY KEY (`id`),
  KEY `idx_seller_login` (`seller_login`),
  KEY `idx_sent_at`      (`sent_at`),
  KEY `idx_send_date`    (`send_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  COMMENT='催收消息发送记录（一行=一次发送，看板统计催收次数与最近催收时间）';

-- ----------------------------------------------------------------------------
-- 表 5: import_log —— 数据导入日志
--   每次执行导入都会记录一行，方便排查「数据为什么没更新」。
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `import_log` (
  `id`          INT          NOT NULL AUTO_INCREMENT COMMENT '自增主键',
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
  KEY `idx_kind`        (`kind`),
  KEY `idx_imported_at` (`imported_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  COMMENT='数据导入日志';

-- ----------------------------------------------------------------------------
-- 视图: v_unmatched_seller_name —— 待人工比对的销方名称清单
--   看板「名称映射」页直接读这个视图。
--   排除两类销方名称：① 已建立映射（seller_company 非空）
--                     ② 人工已忽略（is_ignored = 1，确认没有对应的 1688 商家）
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW `v_unmatched_seller_name` AS
SELECT
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
GROUP BY i.`seller_name`;
