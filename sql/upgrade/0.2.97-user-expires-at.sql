-- ============================================================================
-- 升级脚本 v0.2.97 · 用户使用期限（app_user.expires_at）
-- ----------------------------------------------------------------------------
-- 变更内容：app_user 增加一列 expires_at（DATETIME NULL）
--   · NULL  = 永久有效
--   · 有值  = 该时间之后禁止登录，且已登录会话调用任何接口都会被拒绝
--   · 新建用户默认 expires_at = NOW() + 1 个月（由程序写入，不依赖本脚本）
--   · 存量账号升级后一律为 NULL（永久），不会因为本次升级被踢下线
--
-- 执行方式（任选其一）：
--   命令行：mysql -u root -p invoice_bot < sql/upgrade/0.2.97-user-expires-at.sql
--   图形化：在 Navicat / DBeaver 里选中目标库后整段执行
--
-- 幂等性：脚本通过 information_schema 判断列是否存在，重复执行不会报错。
-- 回滚：ALTER TABLE `app_user` DROP COLUMN `expires_at`;
-- ============================================================================

SET @db := DATABASE();

SET @has_col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'app_user' AND COLUMN_NAME = 'expires_at'
);

SET @ddl := IF(@has_col = 0,
  'ALTER TABLE `app_user` ADD COLUMN `expires_at` DATETIME NULL DEFAULT NULL COMMENT ''使用到期时间（NULL=永久有效；超过后禁止登录与所有接口）'' AFTER `status`',
  'SELECT ''app_user.expires_at 已存在，跳过加列'' AS msg'
);

PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 执行后自检：应看到 expires_at 一行，且现有账号该列为 NULL（永久）
SELECT `id`, `username`, `role`, `status`, `expires_at`
  FROM `app_user`
 ORDER BY `id`;
