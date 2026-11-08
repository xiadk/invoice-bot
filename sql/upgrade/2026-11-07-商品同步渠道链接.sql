-- ============================================================================
-- 2026-11-07 商品同步「渠道商品链接」列（1688 比价目标价映射）
--
-- 用途：
--   1) brand_product 加 supplier_link（牵牛花 store-warehouse/page-query 返回的
--      replenish.supplierGoods.channelGoods.detailUrl，形如 detail.1688.com/offer/xxx）
--   2) 加索引 idx_bp_supplier_link，供 1688 比价按链接精确匹配目标价
--   3) 老数据回填：从个人补货行 product_item.supplier_link 按 (brand_id, sku) 补一份，
--      只填空值，不覆盖已有链接；之后每次「商品同步」会按接口最新值覆盖更新
--
-- 为什么必须补这一列：
--   lib/qnh.js 的 upsertBrandProducts 已把 supplier_link 写进 INSERT/UPDATE，
--   老库若没加列，商品同步整批写入会报 Unknown column；全新部署若 schema.sql 没写，
--   建库时同样缺列。本脚本与 db.js migrate() 做的事等价。
--
-- 执行：mysql -u<user> -p <dbname> < 2026-11-07-商品同步渠道链接.sql
--       （重启服务时 db.js 的 migrate() 也会自动做同样的事，两者等效，跑一次即可）
-- 幂等：是。加列/加索引前查 information_schema；回填只写空值；
--       product_item 没有 supplier_link 列时自动跳过回填，不会报错。
--
-- 回滚（顺序不能反：先删索引，再删列）：
--   ALTER TABLE `brand_product` DROP INDEX `idx_bp_supplier_link`;
--   ALTER TABLE `brand_product` DROP COLUMN `supplier_link`;
--   （老代码不读这一列；回滚后 1688 比价只剩 product_item 补货参考与品名兜底）
-- ============================================================================

SET @db := DATABASE();

-- ── 1. 加列 ─────────────────────────────────────────────────────────────────
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'brand_product' AND COLUMN_NAME = 'supplier_link') = 0,
  'ALTER TABLE `brand_product` ADD COLUMN `supplier_link` VARCHAR(512) DEFAULT NULL COMMENT ''渠道商品链接（detail.1688.com/offer，1688比价匹配键）'' AFTER `image_url`',
  'SELECT ''brand_product.supplier_link 已存在'' AS skip_msg');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 2. 老数据回填（只补空值；product_item 无该列时跳过）──────────────────────
SET @has_pi := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'product_item' AND COLUMN_NAME = 'supplier_link');
SET @sql := IF(@has_pi > 0,
  'UPDATE `brand_product` bp JOIN ('
    'SELECT brand_id, sku, MAX(supplier_link) AS v FROM `product_item` '
    'WHERE supplier_link IS NOT NULL AND LENGTH(supplier_link) > 0 GROUP BY brand_id, sku'
  ') m ON m.brand_id = bp.brand_id AND m.sku = bp.sku '
  'SET bp.supplier_link = m.v '
  'WHERE (bp.supplier_link IS NULL OR LENGTH(bp.supplier_link) = 0) AND m.v IS NOT NULL',
  'SELECT ''product_item.supplier_link 不存在，跳过回填'' AS skip_msg');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 3. 加索引 ───────────────────────────────────────────────────────────────
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'brand_product' AND INDEX_NAME = 'idx_bp_supplier_link') = 0,
  'ALTER TABLE `brand_product` ADD INDEX `idx_bp_supplier_link` (`supplier_link`)',
  'SELECT ''idx_bp_supplier_link 已存在'' AS skip_msg');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
