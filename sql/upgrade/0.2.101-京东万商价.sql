-- ============================================================================
-- 升级脚本 v0.2.101 · 补货页京东万商价（jd_sku_id）
-- ----------------------------------------------------------------------------
-- 变更内容：两张商品表各增加一列 jd_sku_id（VARCHAR(64) NULL）
--   · brand_product.jd_sku_id  品牌级商品关联的万商 skuId（同品牌全员共享，补货页读它）
--   · product_item.jd_sku_id   个人补货行关联的万商 skuId（该 SKU 还没进品牌商品表时兜底）
--   · 另为 brand_product 加索引 idx_bp_jd (brand_id, jd_sku_id)
--
-- 新列含义：京东万商（b.jd.com）商品的 skuId，形如 10235591362865。
--   NULL = 未关联（补货页该行显示「关联」按钮）。
--
-- 执行方式（任选其一）：
--   命令行：mysql -u root -p invoice_bot < sql/upgrade/0.2.101-京东万商价.sql
--   图形化：在 Navicat / DBeaver 里选中目标库后整段执行
--   什么都不做也可以 —— 程序启动时 db.js 的 migrate() 会自动执行同样的变更
--
-- 幂等性：两处都通过 information_schema 判断列/索引是否存在，重复执行不会报错。
--
-- 回滚：
--   ALTER TABLE `brand_product` DROP INDEX `idx_bp_jd`;
--   ALTER TABLE `brand_product` DROP COLUMN `jd_sku_id`;
--   ALTER TABLE `product_item`  DROP COLUMN `jd_sku_id`;
-- ============================================================================

SET @db := DATABASE();

-- ① brand_product.jd_sku_id ------------------------------------------------
SET @has_col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'brand_product' AND COLUMN_NAME = 'jd_sku_id'
);
SET @ddl := IF(@has_col = 0,
  'ALTER TABLE `brand_product` ADD COLUMN `jd_sku_id` VARCHAR(64) DEFAULT NULL COMMENT ''关联的京东万商 skuId（b.jd.com 商品ID）'' AFTER `afa_goods_id`',
  'SELECT ''brand_product.jd_sku_id 已存在，跳过加列'' AS msg'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ② brand_product 索引 ------------------------------------------------------
SET @has_idx := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'brand_product' AND INDEX_NAME = 'idx_bp_jd'
);
SET @ddl := IF(@has_idx = 0,
  'ALTER TABLE `brand_product` ADD KEY `idx_bp_jd` (`brand_id`, `jd_sku_id`)',
  'SELECT ''brand_product.idx_bp_jd 已存在，跳过加索引'' AS msg'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ③ product_item.jd_sku_id -------------------------------------------------
SET @has_col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'product_item' AND COLUMN_NAME = 'jd_sku_id'
);
SET @ddl := IF(@has_col = 0,
  'ALTER TABLE `product_item` ADD COLUMN `jd_sku_id` VARCHAR(64) DEFAULT NULL COMMENT ''关联的京东万商 skuId（b.jd.com 商品ID，用于取万商价）'' AFTER `afa_goods_id`',
  'SELECT ''product_item.jd_sku_id 已存在，跳过加列'' AS msg'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 执行后自检：两列都应在，且现有行默认为 NULL（未关联）
SELECT 'brand_product' AS tbl, COUNT(*) AS total, SUM(jd_sku_id IS NOT NULL) AS linked
  FROM `brand_product`
UNION ALL
SELECT 'product_item' AS tbl, COUNT(*) AS total, SUM(jd_sku_id IS NOT NULL) AS linked
  FROM `product_item`;
