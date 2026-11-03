-- ----------------------------------------------------------------------------
-- v0.3.7 货单软删除
--
-- 用途：货单「删除」由物理删除改为软删除 —— 只写 waybill.deleted_at 打时间戳，
--       行和图片记录都保留，七牛对象不动。所有列表 / 金额合计 / 供应商引用计数
--       都按 `deleted_at IS NULL` 过滤，界面上与真删一致。
--       误删恢复：UPDATE waybill SET deleted_at = NULL WHERE id = <货单 id>;
--
-- 执行：mysql -u<user> -p<pwd> <db> < sql/upgrade/0.3.7-货单软删除.sql
--       幂等：列/索引已存在则跳过，可重复执行
--
-- 回滚：
--   ALTER TABLE `waybill` DROP INDEX `idx_waybill_alive`;
--   ALTER TABLE `waybill` DROP COLUMN `deleted_at`;
-- ----------------------------------------------------------------------------

SET NAMES utf8mb4;

-- 1. 加软删除列
SET @has_col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'waybill' AND COLUMN_NAME = 'deleted_at'
);
SET @sql := IF(@has_col = 0,
  "ALTER TABLE `waybill` ADD COLUMN `deleted_at` DATETIME DEFAULT NULL COMMENT '软删除时间（NULL=有效；删除只在库里打标记，列表/统计一律过滤）' AFTER `created_at`",
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- 2. 补索引（列表默认按 user_id + deleted_at IS NULL 过滤）
SET @has_idx := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'waybill' AND INDEX_NAME = 'idx_waybill_alive'
);
SET @sql := IF(@has_idx = 0,
  'ALTER TABLE `waybill` ADD KEY `idx_waybill_alive` (`user_id`, `deleted_at`)',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- 3. 核对
SELECT COUNT(*) AS 货单总数,
       SUM(`deleted_at` IS NOT NULL) AS 已软删除
  FROM `waybill`;
