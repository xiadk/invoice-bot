-- ============================================================================
-- 升级脚本 v0.2.104 · 员工账号 + 售后管理 + 退款原因
-- ----------------------------------------------------------------------------
-- 变更内容：
--   ① app_user 增加 owner_id —— 员工账号指向「老板」的 app_user.id
--        NULL     = 自主账号（现有全部账号都是 NULL，升级后行为完全不变）
--        有值      = 员工号：登录后所有业务数据都落在 owner_id 名下，
--                    自己那一行只承载登录凭据 + 菜单开关（*_enabled）
--        另加索引 idx_app_user_owner
--   ② app_user 增加 after_sale_enabled —— 「售后管理」菜单开关（默认 0=关闭）
--   ③ qnh_refund_order 增加 5 列：
--        refund_reason      人工填写的「退款原因」，页面优先展示；同步只写平台字段，不会覆盖它
--        after_sale_status  售后处理状态：0待处理 1已申请 2已退货 3已退款（默认 0）
--        after_sale_note    售后备注
--        after_sale_by      最后处理人（登录账号）
--        after_sale_at      最后处理时间
--        另加索引 idx_qro_after (user_id, after_sale_status)
--
-- 注意：qnh_* 表历来由 db.js 建（不在 sql/schema.sql 里），所以这些列的「全新建库口径」
--       落在 db.js 的 ensureQnhSchema()，本脚本只负责老库升级，效果与重启服务自动迁移一致。
--       存量 206 笔退单的 after_sale_status 会全部为 0（待处理），退款原因为空（回落到平台原值）。
--
-- 执行方式（任选其一）：
--   命令行：mysql -u root -p invoice_bot < sql/upgrade/0.2.104-员工与售后.sql
--   图形化：在 Navicat / DBeaver 里选中目标库后整段执行
--   什么都不做也可以 —— 程序启动时 db.js 的 migrate() 会自动执行同样的变更
--
-- 幂等性：每处都先用 information_schema 判断列/索引是否存在，重复执行不报错。
--
-- 回滚：
--   ALTER TABLE `app_user` DROP INDEX `idx_app_user_owner`;
--   ALTER TABLE `app_user` DROP COLUMN `owner_id`;
--   ALTER TABLE `app_user` DROP COLUMN `after_sale_enabled`;
--   ALTER TABLE `qnh_refund_order` DROP INDEX `idx_qro_after`;
--   ALTER TABLE `qnh_refund_order` DROP COLUMN `refund_reason`,
--     DROP COLUMN `after_sale_status`, DROP COLUMN `after_sale_note`,
--     DROP COLUMN `after_sale_by`, DROP COLUMN `after_sale_at`;
--   （回滚前先把所有 owner_id 非 NULL 的账号处理掉，否则这些员工号会找不到归属）
-- ============================================================================

SET @db := DATABASE();

-- ① app_user.owner_id -------------------------------------------------------
SET @has_col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'app_user' AND COLUMN_NAME = 'owner_id'
);
SET @ddl := IF(@has_col = 0,
  'ALTER TABLE `app_user` ADD COLUMN `owner_id` INT DEFAULT NULL COMMENT ''归属主体账号（员工号指向老板的 app_user.id；NULL=自主账号）'' AFTER `brand_id`',
  'SELECT ''app_user.owner_id 已存在，跳过加列'' AS msg'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ② app_user 索引 idx_app_user_owner ---------------------------------------
SET @has_idx := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'app_user' AND INDEX_NAME = 'idx_app_user_owner'
);
SET @ddl := IF(@has_idx = 0,
  'ALTER TABLE `app_user` ADD KEY `idx_app_user_owner` (`owner_id`)',
  'SELECT ''app_user.idx_app_user_owner 已存在，跳过加索引'' AS msg'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ③ app_user.after_sale_enabled --------------------------------------------
SET @has_col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'app_user' AND COLUMN_NAME = 'after_sale_enabled'
);
SET @ddl := IF(@has_col = 0,
  'ALTER TABLE `app_user` ADD COLUMN `after_sale_enabled` TINYINT(1) NOT NULL DEFAULT 0 COMMENT ''是否允许查看售后管理页（1=开启，超级管理员始终可见）''',
  'SELECT ''app_user.after_sale_enabled 已存在，跳过加列'' AS msg'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ④ qnh_refund_order 售后 / 退款原因 5 列 ------------------------------------
SET @has_col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'qnh_refund_order' AND COLUMN_NAME = 'refund_reason'
);
SET @ddl := IF(@has_col = 0,
  'ALTER TABLE `qnh_refund_order` ADD COLUMN `refund_reason` VARCHAR(512) DEFAULT NULL COMMENT ''人工填写的退款原因（同步不覆盖，页面优先展示）'' AFTER `audit_reason`',
  'SELECT ''qnh_refund_order.refund_reason 已存在，跳过加列'' AS msg'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'qnh_refund_order' AND COLUMN_NAME = 'after_sale_status'
);
SET @ddl := IF(@has_col = 0,
  'ALTER TABLE `qnh_refund_order` ADD COLUMN `after_sale_status` TINYINT NOT NULL DEFAULT 0 COMMENT ''售后处理状态：0待处理 1已申请 2已退货 3已退款'' AFTER `refund_reason`',
  'SELECT ''qnh_refund_order.after_sale_status 已存在，跳过加列'' AS msg'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'qnh_refund_order' AND COLUMN_NAME = 'after_sale_note'
);
SET @ddl := IF(@has_col = 0,
  'ALTER TABLE `qnh_refund_order` ADD COLUMN `after_sale_note` VARCHAR(255) DEFAULT NULL COMMENT ''售后备注'' AFTER `after_sale_status`',
  'SELECT ''qnh_refund_order.after_sale_note 已存在，跳过加列'' AS msg'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'qnh_refund_order' AND COLUMN_NAME = 'after_sale_by'
);
SET @ddl := IF(@has_col = 0,
  'ALTER TABLE `qnh_refund_order` ADD COLUMN `after_sale_by` VARCHAR(64) DEFAULT NULL COMMENT ''最后处理人'' AFTER `after_sale_note`',
  'SELECT ''qnh_refund_order.after_sale_by 已存在，跳过加列'' AS msg'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'qnh_refund_order' AND COLUMN_NAME = 'after_sale_at'
);
SET @ddl := IF(@has_col = 0,
  'ALTER TABLE `qnh_refund_order` ADD COLUMN `after_sale_at` DATETIME DEFAULT NULL COMMENT ''最后处理时间'' AFTER `after_sale_by`',
  'SELECT ''qnh_refund_order.after_sale_at 已存在，跳过加列'' AS msg'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ⑤ qnh_refund_order 售后状态索引 ------------------------------------------
SET @has_idx := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'qnh_refund_order' AND INDEX_NAME = 'idx_qro_after'
);
SET @ddl := IF(@has_idx = 0,
  'ALTER TABLE `qnh_refund_order` ADD KEY `idx_qro_after` (`user_id`, `after_sale_status`)',
  'SELECT ''qnh_refund_order.idx_qro_after 已存在，跳过加索引'' AS msg'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 执行后自检：员工账号数（应为 0）+ 售后状态分布（应全部 0=待处理）
SELECT COUNT(*) AS staff_accounts FROM `app_user` WHERE `owner_id` IS NOT NULL;
SELECT `after_sale_status`, COUNT(*) AS n FROM `qnh_refund_order` GROUP BY `after_sale_status`;
