-- ----------------------------------------------------------------------------
-- v0.3.11 本地价规格（整件价 / 单价 / 规格数量）
--
-- 背景：补货页的「本地价」原来是单个输入框，只能填一个数（按单价理解）。实际线下报价
--       常常是「一件多少钱 + 一件几个」，需要两种填法互相折算，列表也要同时展示整件价、
--       单价和规格数量；没填规格数量时表示只有单价、没有整件价。
--
-- 本次只加两列，local_price 的语义（单价）保持不变，存量数据不用迁移：
--   local_spec_qty   一件含多少个基础单位（NULL = 只填了单价）
--   local_pack_price 整件价（= 单价 × 规格数量；规格为空时为 NULL）
--
-- 两张表都加（与 local_price 同口径）：brand_product 是品牌级主数据（商品列表/补货页读它），
--   product_item 是补货导入的个人行（品牌商品表还没同步到该 SKU 时的回退落点）。
--   写入仍走 writeProductLink 的规则：品牌商品表有该 SKU 写品牌，没有才写个人行。
--
-- 执行：mysql -u<user> -p<pwd> <db> < sql/upgrade/0.3.11-本地价规格.sql
--       或直接重启服务 —— db.js 的 migrate() 会自动补这两列（幂等）。
--
-- 回滚：ALTER TABLE `brand_product` DROP COLUMN `local_spec_qty`, DROP COLUMN `local_pack_price`;
--       ALTER TABLE `product_item`  DROP COLUMN `local_spec_qty`, DROP COLUMN `local_pack_price`;
--       （只丢规格与整件价，local_price 与其它数据不受影响）
--
-- 回填（可选）：想把已有单价的商品补上整件价，先有规格数量才能算，所以不自动回填。
-- ----------------------------------------------------------------------------

-- ── brand_product ────────────────────────────────────────────────────────────
SET @need := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'brand_product' AND COLUMN_NAME = 'local_spec_qty'
);
SET @sql := IF(@need = 0,
  "ALTER TABLE `brand_product` ADD COLUMN `local_spec_qty` DECIMAL(12,2) DEFAULT NULL COMMENT '本地价规格数量（一件含多少个基础单位；NULL=只填了单价）' AFTER `local_price`",
  'SELECT ''brand_product.local_spec_qty 已存在，跳过'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @need := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'brand_product' AND COLUMN_NAME = 'local_pack_price'
);
SET @sql := IF(@need = 0,
  "ALTER TABLE `brand_product` ADD COLUMN `local_pack_price` DECIMAL(12,2) DEFAULT NULL COMMENT '本地价整件价（= 单价 × 规格数量；规格为空时为 NULL）' AFTER `local_spec_qty`",
  'SELECT ''brand_product.local_pack_price 已存在，跳过'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── product_item ─────────────────────────────────────────────────────────────
SET @need := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'product_item' AND COLUMN_NAME = 'local_spec_qty'
);
SET @sql := IF(@need = 0,
  "ALTER TABLE `product_item` ADD COLUMN `local_spec_qty` DECIMAL(12,2) DEFAULT NULL COMMENT '本地价规格数量（一件含多少个基础单位；NULL=只填了单价）' AFTER `local_price`",
  'SELECT ''product_item.local_spec_qty 已存在，跳过'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @need := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'product_item' AND COLUMN_NAME = 'local_pack_price'
);
SET @sql := IF(@need = 0,
  "ALTER TABLE `product_item` ADD COLUMN `local_pack_price` DECIMAL(12,2) DEFAULT NULL COMMENT '本地价整件价（= 单价 × 规格数量；规格为空时为 NULL）' AFTER `local_spec_qty`",
  'SELECT ''product_item.local_pack_price 已存在，跳过'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── 核对 ─────────────────────────────────────────────────────────────────────
-- 两张表都应各有 local_spec_qty / local_pack_price 两行：
-- SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS
--  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('brand_product','product_item')
--    AND COLUMN_NAME IN ('local_price','local_spec_qty','local_pack_price') ORDER BY 1,2;
