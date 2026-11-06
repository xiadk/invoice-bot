-- ============================================================================
-- 2026-11-06 商品售后「商品图片」列（售后列表新增图片列 + 新增页显示商品主图）
--
-- 用途：
--   1) product_after 加 image_url（商品主图快照，列表在「商品名称」左侧显示）
--   2) 老数据回填：按 sku 从 brand_product.image_url 取图（已有值一律不覆盖）
--
-- 【为什么要加列而不是列表 JOIN 商品表】
--   · brand_product 的 SKU 跨品牌可能重复，JOIN 要 GROUP BY/MIN 去重，列表每次都要扫
--     1.3 万行的商品表；
--   · 售后是历史台账，存「当时那个商品」的图更符合语义，商品库后来换图不影响老记录。
--
-- 执行：mysql -u<user> -p <dbname> < 2026-11-06-商品售后商品图片.sql
--       （重启服务时 db.js 的 migrate() 也会自动做同样的事，两者等效，跑一次即可）
-- 幂等：是。加列前查 information_schema；回填只写空值。
--
-- 回滚：
--   ALTER TABLE `product_after` DROP COLUMN `image_url`;
--   （老代码不读这一列，回滚后列表/新增页只是不再显示商品图，其它功能不受影响）
-- ============================================================================

SET @db := DATABASE();

-- ── 1. 加列 ─────────────────────────────────────────────────────────────────
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'product_after' AND COLUMN_NAME = 'image_url') = 0,
  'ALTER TABLE `product_after` ADD COLUMN `image_url` VARCHAR(512) DEFAULT NULL COMMENT ''商品主图（选中商品时快照，列表展示用）'' AFTER `sku`',
  'SELECT ''product_after.image_url 已存在'' AS skip_msg');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 2. 老数据回填（按 SKU 关联商品库；同一 SKU 多行取 MIN 稳定值）──────────────
--    只补空值：新增售后时 createAfter 已按选中商品存过图的记录不会被改。
--    商品库里找不到该 SKU 的（早期手填数据）保持 NULL，列表显示「—」。
UPDATE `product_after` a
  JOIN (SELECT `sku`, MIN(`image_url`) AS `image_url`
          FROM `brand_product`
         WHERE `image_url` IS NOT NULL AND `image_url` <> ''
         GROUP BY `sku`) t
    ON t.`sku` = a.`sku`
   SET a.`image_url` = t.`image_url`
 WHERE a.`image_url` IS NULL OR a.`image_url` = '';

-- ── 3. 自检（可选）─────────────────────────────────────────────────────────
-- SELECT COUNT(*) AS total,
--        SUM(image_url IS NOT NULL AND image_url <> '') AS with_image
--   FROM product_after;
