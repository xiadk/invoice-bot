-- ----------------------------------------------------------------------------
-- v0.3.6 货单开票状态
--
-- 用途：货单管理列表「图片」右边新增「开票状态」列（未开票 / 已开票，点击可切换），
--       列表原来的「备注」列下线（note 列保留，历史导入时用来记原始行来源）。
--
-- 执行：mysql -u<user> -p<pwd> <db> < sql/upgrade/0.3.6-货单开票状态.sql
--       或直接重启服务 —— db.js 的 migrate() 会自动补这一列（幂等）。
--
-- 回滚：ALTER TABLE `waybill` DROP COLUMN `invoice_status`;
--       （只丢开票状态，货单与图片不受影响）
--
-- 说明：无数据迁移。存量货单 auto_default 0 = 未开票。
-- ----------------------------------------------------------------------------

SET @need := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'waybill'
     AND COLUMN_NAME  = 'invoice_status'
);

SET @sql := IF(@need = 0,
  "ALTER TABLE `waybill` ADD COLUMN `invoice_status` TINYINT NOT NULL DEFAULT 0 COMMENT '开票状态：0未开票 1已开票（v0.3.6）' AFTER `bill_date`",
  'SELECT ''invoice_status 已存在，跳过'' AS msg');

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
