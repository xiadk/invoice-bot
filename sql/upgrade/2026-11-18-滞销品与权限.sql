-- ============================================================================
-- 2026-11-18 滞销品列表 + 两项独立菜单权限
--
-- 用途：
--   1) brand_product 加 4 列，供「滞销品列表」按月/周/日销、最近补货、供应商筛选：
--        · sales_7d          7 天销量（接口有则写，无则 0）
--        · sales_1d          1 天销量（接口有则写，无则 0）
--        · last_replenish_at 最近补货时间（接口有则写，无则 NULL）
--        · supplier_flag     供应商标识（命中「1688-」前缀则写入；滞销筛选口径）
--   2) app_user 加 2 列独立菜单权限（默认 0，超级管理员恒可见，不受此列影响）：
--        · slowmove_enabled      滞销品列表
--        · product_sync_enabled  商品同步（原来仅超管，现可单独授权）
--
-- 为什么必须补这些列：
--   lib/qnh.js 的 upsertBrandProducts 会写 4 个新列，server.js 的新路由会读它们；
--   老库若没加列，商品同步整批写入会报 Unknown column。全新部署若 schema.sql 没写，
--   建库时同样缺列。本脚本与 db.js migrate() 做的事等价。
--
-- 执行：mysql -u<user> -p <dbname> < 2026-11-18-滞销品与权限.sql
--       （重启服务时 db.js 的 migrate() 也会自动做同样的事，两者等效，跑一次即可）
-- 幂等：是。每列加列前都查 information_schema，已存在则跳过。
--       所有新列默认 0 / NULL / ''，不会把历史商品误判为滞销、也不改任何已有数据。
--
-- 回滚（直接删列即可，无索引、无数据迁移）：
--   ALTER TABLE `brand_product` DROP COLUMN `supplier_flag`;
--   ALTER TABLE `brand_product` DROP COLUMN `last_replenish_at`;
--   ALTER TABLE `brand_product` DROP COLUMN `sales_1d`;
--   ALTER TABLE `brand_product` DROP COLUMN `sales_7d`;
--   ALTER TABLE `app_user` DROP COLUMN `product_sync_enabled`;
--   ALTER TABLE `app_user` DROP COLUMN `slowmove_enabled`;
--   （回滚后老代码不读这些列；商品同步会退回只写 sales_30d，滞销品菜单不可用）
-- ============================================================================

SET @db := DATABASE();

-- ── 1. brand_product：4 个滞销品字段 ────────────────────────────────────────
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'brand_product' AND COLUMN_NAME = 'sales_7d') = 0,
  'ALTER TABLE `brand_product` ADD COLUMN `sales_7d` INT NOT NULL DEFAULT 0 COMMENT ''7天销量（接口 sale7Num；无则 0）'' AFTER `sales_30d`',
  'SELECT ''brand_product.sales_7d 已存在'' AS skip_msg');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'brand_product' AND COLUMN_NAME = 'sales_1d') = 0,
  'ALTER TABLE `brand_product` ADD COLUMN `sales_1d` INT NOT NULL DEFAULT 0 COMMENT ''1天销量（接口 sale1Num；无则 0）'' AFTER `sales_7d`',
  'SELECT ''brand_product.sales_1d 已存在'' AS skip_msg');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'brand_product' AND COLUMN_NAME = 'last_replenish_at') = 0,
  'ALTER TABLE `brand_product` ADD COLUMN `last_replenish_at` DATETIME DEFAULT NULL COMMENT ''最近一次补货时间（接口最近补货字段；无则 NULL）'' AFTER `sales_1d`',
  'SELECT ''brand_product.last_replenish_at 已存在'' AS skip_msg');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'brand_product' AND COLUMN_NAME = 'supplier_flag') = 0,
  'ALTER TABLE `brand_product` ADD COLUMN `supplier_flag` VARCHAR(64) NOT NULL DEFAULT '''' COMMENT ''供应商标识（1688- 前缀命中；滞销品筛选口径）'' AFTER `last_replenish_at`',
  'SELECT ''brand_product.supplier_flag 已存在'' AS skip_msg');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 2. app_user：2 个独立菜单权限 ───────────────────────────────────────────
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'app_user' AND COLUMN_NAME = 'slowmove_enabled') = 0,
  'ALTER TABLE `app_user` ADD COLUMN `slowmove_enabled` TINYINT(1) NOT NULL DEFAULT 0 COMMENT ''是否允许查看「滞销品列表」页（1=开启，超级管理员始终可见）''',
  'SELECT ''app_user.slowmove_enabled 已存在'' AS skip_msg');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'app_user' AND COLUMN_NAME = 'product_sync_enabled') = 0,
  'ALTER TABLE `app_user` ADD COLUMN `product_sync_enabled` TINYINT(1) NOT NULL DEFAULT 0 COMMENT ''是否允许使用「商品同步」（1=开启，超级管理员始终可见）''',
  'SELECT ''app_user.product_sync_enabled 已存在'' AS skip_msg');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
