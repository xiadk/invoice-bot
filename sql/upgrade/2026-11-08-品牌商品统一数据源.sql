-- ============================================================================
-- 2026-11-08 品牌商品统一数据源（补货参考导入写回 + 建议量列）
--
-- 用途：
--   1) brand_product 加 suggest_qty（建议量，基础单位）
--   2) 老数据回填：从个人补货行 product_item 按 (brand_id, sku) 取历史最大建议量
--   3) 配合代码改动：采购价 / 可用库存 / 在途库存 / 建议量 这四类字段的**唯一权威表**
--      改为 brand_product，商品列表 / 比价分析 / 补货单实时库存 / 交易市场发布一律只读这里
--
-- 为什么必须补这一列：
--   「商品同步」写 brand_product 的采购价/可用库存/在途库存，但不写建议量；
--   「补货菜单导入前置仓补货参考文件」原先只写 product_item，批次视图读的是
--   COALESCE(bp.x, pi.x)，而 bp 三列 NOT NULL DEFAULT 0 → 永远命中同步值，
--   文件里的最新值写了读不出来。改完代码后导入会按 (brand_id, sku) upsert 回 bp。
--   老库若没加列，导入整批写入会报 Unknown column；全新部署由 schema.sql 负责。
--
-- 执行：mysql -u<user> -p <dbname> < 2026-11-08-品牌商品统一数据源.sql
--       （重启服务时 db.js 的 migrate() 也会自动做同样的事，两者等效，跑一次即可）
-- 幂等：是。加列前查 information_schema；回填只在「本次刚加列」时执行一次，
--       重复执行不会把导入文件里合法的 0 建议量重新顶成历史值。
--
-- 注意：采购价 / 可用库存 / 在途库存 **不做回填** —— 这三列原本就存在于 bp，
--       且旧代码 COALESCE(bp.x, pi.x) 一直优先取 bp，切换读源不会产生读数回归；
--       下一次「补货参考导入」或「商品同步」会按最新值覆盖。
--
-- 回滚（先回滚代码，再删列）：
--   ALTER TABLE `brand_product` DROP COLUMN `suggest_qty`;
--   （删列后导入写回语句会报 Unknown column，必须先把代码回退到不写 suggest_qty 的版本）
-- ============================================================================

SET @db := DATABASE();
SET @cnt := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'brand_product' AND COLUMN_NAME = 'suggest_qty');
SET @added := (@cnt = 0);

-- ── 1. 加列 ─────────────────────────────────────────────────────────────────
SET @sql := IF(@added,
  'ALTER TABLE `brand_product` ADD COLUMN `suggest_qty` INT NOT NULL DEFAULT 0 COMMENT ''建议量（基础单位，补货参考文件；商品同步不写此列）'' AFTER `transit_stock`',
  'SELECT ''brand_product.suggest_qty 已存在'' AS skip_msg');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 2. 历史建议量回填（只在本次刚加列时跑；product_item 无该列时跳过）────────
SET @has_pi := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'product_item' AND COLUMN_NAME = 'suggest_qty');
SET @sql := IF(@added AND @has_pi > 0,
  'UPDATE `brand_product` bp JOIN ('
    'SELECT brand_id, sku, MAX(suggest_qty) AS v FROM `product_item` '
    'WHERE (source_file IS NULL OR source_file NOT LIKE ''比价参考|%'') AND suggest_qty > 0 '
    'GROUP BY brand_id, sku'
  ') m ON m.brand_id = bp.brand_id AND m.sku = bp.sku '
  'SET bp.suggest_qty = m.v WHERE bp.suggest_qty = 0 AND m.v > 0',
  'SELECT ''无需回填建议量'' AS skip_msg');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
