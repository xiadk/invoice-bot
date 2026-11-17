-- ============================================================================
-- 2026-11-18（二）滞销品口径校准：sales_1d 改名 sales_14d
--
-- 背景：
--   上一轮（2026-11-18 滞销品与权限.sql）按「月/周/日销」口径加了 sales_7d/sales_1d。
--   本轮用线上助手实时诊断抓到牵牛花商品接口的真实字段：saleQuantity 只有
--     sale7Num / sale14Num / sale30Num，**根本没有单日销量**。
--   用户确认：滞销品口径改为「7/14/30 天销量全为 0」（判断逻辑不变），
--   因此把 sales_1d 平滑改名为 sales_14d（14 天销量）。
--
-- 影响：
--   · 只改列名 + 注释，**数据保留**（老库历史值多为 0，改名后按 14 天口径解读）
--   · 供应商筛选口径不变：supplier_flag 以「1688-」前缀过滤（真实字段 replenish.senderName）
--   · 最近补货 last_replenish_at 不变（真实字段 recentlyReplenish.time）
--
-- 执行：mysql -u<user> -p <dbname> < 2026-11-18b-sales_1d改名sales_14d.sql
--       （重启服务时 db.js 的 migrate() 也会自动做同样的事，两者等效，跑一次即可）
-- 幂等：是。仅当 sales_1d 存在且 sales_14d 不存在时才改名；全新库已直接建 sales_14d，跳过。
--
-- 回滚：
--   ALTER TABLE `brand_product` CHANGE COLUMN `sales_14d` `sales_1d` INT NOT NULL DEFAULT 0
--     COMMENT '1天销量（接口 sale1Num；无则 0）';
-- ============================================================================

SET @db := DATABASE();

-- 仅当老库有 sales_1d 且还没有 sales_14d 时，改名（全新库已建 sales_14d，此步跳过）
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'brand_product' AND COLUMN_NAME = 'sales_1d') = 1
  AND
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'brand_product' AND COLUMN_NAME = 'sales_14d') = 0,
  'ALTER TABLE `brand_product` CHANGE COLUMN `sales_1d` `sales_14d` INT NOT NULL DEFAULT 0 COMMENT ''14天销量（接口 sale14Num；无则 0）''',
  'SELECT ''brand_product: sales_14d 已就位，无需改名'' AS skip_msg');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
