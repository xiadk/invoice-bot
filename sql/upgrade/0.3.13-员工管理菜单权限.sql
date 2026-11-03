-- ============================================================================
-- 0.3.13 「员工管理」改为按菜单权限开放
--
-- 用途：
--   1) app_user 加 staff_enabled（「员工管理」菜单开关）
--      · 加列瞬间把「名下已经有员工」的主体账号置 1，否则升级那一刻老板就找不到员工管理，
--        还得等超管逐个来开；其余账号保持 0，由超管在用户管理里按需开。
--      · 只在刚加列的那一次回填，重复执行本脚本不会把超管手工关掉的又打开。
--   2) 本版本另外两处是纯应用逻辑（不改表结构），无需 DDL：
--      · 供应商「迁移」：把旧供应商名下的货单 / 供应商售后 / 补货单 / 商品本地价引用
--        全部改挂到新供应商，并按需删除旧供应商（lib/waybill.js › mergeSupplier）
--      · 删除供应商：货单 / 售后 / 补货单任一还有数据就拒绝删除（lib/waybill.js › deleteSupplier）
--
-- 执行：mysql -u<user> -p <dbname> < 0.3.13-员工管理菜单权限.sql
--       （重启服务时 db.js 的 migrate() 也会自动做同样的事，两者等效，跑一次即可）
-- 幂等：加列前先查 information_schema；回填只在「刚加列」时执行
--
-- 回滚：
--   ALTER TABLE `app_user` DROP COLUMN `staff_enabled`;
--   （回滚后「员工管理」恢复成 v0.2.104 的规则：所有主体账号默认可见）
-- ============================================================================

SET @db := DATABASE();
SET @had_staff := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'app_user' AND COLUMN_NAME = 'staff_enabled'
);

-- ── 1. 菜单开关列 ───────────────────────────────────────────────────────────
SET @sql := IF(@had_staff = 0,
  'ALTER TABLE `app_user` ADD COLUMN `staff_enabled` TINYINT(1) NOT NULL DEFAULT 0 COMMENT ''是否允许查看员工管理页（1=开启，超级管理员走用户管理；v0.3.13）'' AFTER `replenish_order_enabled`',
  'SELECT ''app_user.staff_enabled 已存在'' AS skip_msg');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 2. 存量兼容：已有员工的主体账号默认开启 ─────────────────────────────────
--    派生表包一层，避开 MySQL/MariaDB「不能在 UPDATE 的子查询里引用目标表」的限制。
SET @sql := IF(@had_staff = 0,
  'UPDATE `app_user` SET `staff_enabled` = 1 WHERE `id` IN (SELECT `x`.`owner_id` FROM (SELECT DISTINCT `owner_id` FROM `app_user` WHERE `owner_id` IS NOT NULL AND `owner_id` > 0) `x`)',
  'SELECT ''staff_enabled 列本来就存在，跳过存量回填'' AS skip_msg');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 3. 校验（人工核对用）───────────────────────────────────────────────────
-- 有员工但没开权限的主体应该为 0 行：
--   SELECT o.id, o.username, COUNT(s.id) AS staff_cnt
--     FROM app_user o JOIN app_user s ON s.owner_id = o.id
--    WHERE o.owner_id IS NULL AND o.staff_enabled = 0
--    GROUP BY o.id, o.username;
