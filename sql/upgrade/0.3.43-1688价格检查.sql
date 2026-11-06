-- ============================================================================
-- v0.3.43 1688 待付款订单价格检查（单账号口径，去旺旺谈价）
-- ============================================================================
-- 说明：
--   ① product_item 补 4 列供应商维度（待付款订单只有 1688 供应商维度，
--      要拿补货参考当目标价，必须按供应商链接/名称/规格 + 下单比例对得上号）
--   ② 新增 price_check 审计表（每次核对结果；applied_at 标记是否已在 1688 打备注上色）
-- 注意：本文件是供人工执行的升级脚本，线上代码已在 db.js migrate() 里幂等自动建列/建表，
--       此文件仅留档，避免重复执行（语句都已带 IF NOT EXISTS / 存在性判断）。
-- ============================================================================

-- 1) product_item 补列（幂等）
SET @exists_supplier_name := (
  SELECT COUNT(1) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'product_item' AND COLUMN_NAME = 'supplier_name'
);
SET @sql := IF(@exists_supplier_name = 0,
  'ALTER TABLE `product_item` ADD COLUMN `supplier_name` VARCHAR(512) NOT NULL DEFAULT '''' COMMENT ''供应商商品名称（来自补货参考文件）''',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @exists_supplier_spec := (
  SELECT COUNT(1) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'product_item' AND COLUMN_NAME = 'supplier_spec'
);
SET @sql := IF(@exists_supplier_spec = 0,
  'ALTER TABLE `product_item` ADD COLUMN `supplier_spec` VARCHAR(512) NOT NULL DEFAULT '''' COMMENT ''供应商商品规格（来自补货参考文件）''',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @exists_supplier_link := (
  SELECT COUNT(1) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'product_item' AND COLUMN_NAME = 'supplier_link'
);
SET @sql := IF(@exists_supplier_link = 0,
  'ALTER TABLE `product_item` ADD COLUMN `supplier_link` VARCHAR(512) NOT NULL DEFAULT '''' COMMENT ''供应商商品链接（detail.1688.com/offer）''',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @exists_order_ratio := (
  SELECT COUNT(1) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'product_item' AND COLUMN_NAME = 'order_ratio'
);
SET @sql := IF(@exists_order_ratio = 0,
  'ALTER TABLE `product_item` ADD COLUMN `order_ratio` DECIMAL(12,2) NOT NULL DEFAULT 1 COMMENT ''供应商下单比例（一件含基础单位数）''',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2) 商品表（本次导入文件展示）权标不应影响补货主流程，仅加匹配索引
SET @exists_idx := (
  SELECT COUNT(1) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'product_item' AND INDEX_NAME = 'idx_pi_supplier_link'
);
SET @sql := IF(@exists_idx = 0,
  'ALTER TABLE `product_item` ADD KEY `idx_pi_supplier_link` (`supplier_link`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 3) price_check 审计表（幂等建表）
CREATE TABLE IF NOT EXISTS `price_check` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`         INT           NOT NULL COMMENT '归属用户（app_user.id）',
  `brand_id`        INT           NOT NULL DEFAULT 1 COMMENT '用户归属品牌方',
  `run_batch`       VARCHAR(64)   NOT NULL COMMENT '本次检查批次（YYYYMMDDHHmmss）',
  `batch_id`        BIGINT UNSIGNED NULL COMMENT '目标价来源批次（product_import_batch.id；NULL=品牌方全部）',
  `order_id`        VARCHAR(64)   NOT NULL COMMENT '1688订单号',
  `order_time`      VARCHAR(64)   NOT NULL DEFAULT '' COMMENT '下单时间（1688页面原文）',
  `sku`             VARCHAR(64)   NOT NULL DEFAULT '' COMMENT '匹配到的商品SKU',
  `goods_name`      VARCHAR(512)  NOT NULL DEFAULT '' COMMENT '商品名称（品牌方）',
  `supplier_name`   VARCHAR(512)  NOT NULL DEFAULT '' COMMENT '供应商商品名称（1688）',
  `supplier_spec`   VARCHAR(512)  NOT NULL DEFAULT '' COMMENT '供应商商品规格',
  `supplier_link`   VARCHAR(512)  NOT NULL DEFAULT '' COMMENT '供应商商品链接',
  `order_ratio`     DECIMAL(12,2) NOT NULL DEFAULT 1 COMMENT '下单比例（一件含基础单位数）',
  `quantity`        DECIMAL(12,2) NOT NULL DEFAULT 0 COMMENT '采购数量（规格单位）',
  `base_quantity`   DECIMAL(12,2) NOT NULL DEFAULT 0 COMMENT '基础单位数量 = 数量 × order_ratio',
  `spec_price`      DECIMAL(12,2) NOT NULL DEFAULT 0 COMMENT '页面规格单价',
  `target_price`    DECIMAL(12,2) NOT NULL DEFAULT 0 COMMENT '目标采购单价（基础单位）',
  `actual_price`    DECIMAL(12,2) NOT NULL DEFAULT 0 COMMENT '实际到手单价（基础单位，含分摊运费）',
  `freight_share`   DECIMAL(12,2) NOT NULL DEFAULT 0 COMMENT '分摊运费（按商品金额占比）',
  `paid_amount`     DECIMAL(12,2) NOT NULL DEFAULT 0 COMMENT '实付金额',
  `price_diff`      DECIMAL(12,2) NOT NULL DEFAULT 0 COMMENT '差价 = 实际 - 目标',
  `price_ratio`     DECIMAL(8,4)  NOT NULL DEFAULT 0 COMMENT '涨幅 = (实际 - 目标) / 目标',
  `sales_30d`       INT           NOT NULL DEFAULT 0 COMMENT '目标侧30天销量',
  `matched`         TINYINT       NOT NULL DEFAULT 0 COMMENT '是否匹配到目标价',
  `verdict`         VARCHAR(16)   NOT NULL DEFAULT '' COMMENT 'blue/yellow/green/unmatched',
  `reason`          VARCHAR(32)   NOT NULL DEFAULT '' COMMENT '判定原因(price_issue/qty_too_high/new_product/all_reasonable)',
  `is_qty_too_high` TINYINT       NOT NULL DEFAULT 0 COMMENT '采购量过高',
  `memo_text`       VARCHAR(2000) NOT NULL DEFAULT '' COMMENT '要写到1688的备忘文本',
  `checked_at`      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '检查时间',
  `applied_at`      DATETIME      DEFAULT NULL COMMENT '已在1688打备注上色的时间（NULL=未上色）',
  PRIMARY KEY (`id`),
  KEY `idx_pc_user_run` (`user_id`, `run_batch`),
  KEY `idx_pc_order` (`order_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='1688待付款订单价格检查记录';
