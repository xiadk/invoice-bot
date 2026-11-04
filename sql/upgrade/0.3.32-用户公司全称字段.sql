-- ============================================================================
-- 0.3.32 用户「公司全称」字段（与登录账号解耦）
--
-- 用途：
--   1) app_user 加 company_full_name（公司全称）
--   2) 老数据回填：company_full_name = 现有「开票抬头公司名」，为空再退回登录账号
--
-- 【为什么要拆】
--   0.3.31 及以前是「登录账号 = 公司全称」写死的：账号必须是中文公司名
--   （见 server.js 的 USERNAME_RULE / createUser 兜底 / updateUser 改名联动），
--   想用 shanghe 这种简短账号就只能牺牲公司名，反之亦然。
--   v0.3.32 起两者分开：
--     · username           = 登录账号（唯一，可中文也可英文/数字）
--     · company_full_name  = 公司全称（列表/选择/显示优先用它）
--     · company_name       = 开票抬头公司名，默认跟随公司全称（催收话术 {companyName} 不变）
--
-- 执行：mysql -u<user> -p <dbname> < 0.3.32-用户公司全称字段.sql
--       （重启服务时 db.js 的 migrate() 也会自动做同样的事，两者等效，跑一次即可）
-- 幂等：是。加列前查 information_schema；回填只写空值，已有值一律不覆盖。
--
-- 回滚：
--   ALTER TABLE `app_user` DROP COLUMN `company_full_name`;
--   （company_name / username 均未改动，回滚后行为与升级前一致）
-- ============================================================================

SET @db := DATABASE();

-- ── 1. 加列 ─────────────────────────────────────────────────────────────────
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'app_user' AND COLUMN_NAME = 'company_full_name') = 0,
  'ALTER TABLE `app_user` ADD COLUMN `company_full_name` VARCHAR(255) DEFAULT NULL COMMENT ''公司全称（与登录账号分开；列表/选择/显示优先用它；v0.3.32）'' AFTER `expires_at`',
  'SELECT ''app_user.company_full_name 已存在'' AS skip_msg');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 2. 老数据回填 ───────────────────────────────────────────────────────────
--    优先沿用现有开票抬头公司名（历史上有账号单独维护过抬头，这样显示不变），
--    没有抬头才退回登录账号（老库里多数账号「账号即公司名」，两者本来就一致）。
UPDATE `app_user`
   SET `company_full_name` = COALESCE(NULLIF(`company_name`, ''), `username`)
 WHERE `company_full_name` IS NULL OR `company_full_name` = '';

-- ── 3. 自检（可选）─────────────────────────────────────────────────────────
-- SELECT id, username, company_full_name, company_name FROM app_user ORDER BY id;
