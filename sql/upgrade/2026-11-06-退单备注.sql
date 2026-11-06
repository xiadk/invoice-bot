-- ============================================================================
-- 2026-11-06 退单列表「备注」列（备注可编辑、记录操作人与时间；退款原因改只读）
--
-- 用途：
--   qnh_refund_order 加三列：
--     remark     人工备注（退单列表可编辑，同步不覆盖）
--     remark_by  最后编辑人（登录账号 username）
--     remark_at  最后编辑时间
--
-- 【为什么不复用 after_sale_note / after_sale_by / after_sale_at】
--   那三列是 v0.2.104 的「售后处理」标记，v0.3.25 售后页改成商品维度后已完全停用
--   （全库 206 行全是 NULL / 0，代码里零引用）。但语义是「售后处理」而不是「退单备注」，
--   混用会让后来的人分不清哪列是哪套业务的，所以另开三列，旧列保持原样不动。
--
-- 【为什么不写进 sql/schema.sql】
--   这张表（qnh_refund_order）从一开始就不在 schema.sql 里 —— 它是历史 Python 同步
--   工程建的，Node 侧的唯一建表口径是 db.js 的 CREATE TABLE IF NOT EXISTS。本次已同步
--   改 db.js，全新部署一次建对；本脚本只负责给老库补列。
--
-- 执行：mysql -u<user> -p <dbname> < 2026-11-06-退单备注.sql
--       （重启服务时 db.js 的 migrate() 也会自动做同样的事，两者等效，跑一次即可）
-- 幂等：是。每次加列前查 information_schema，已存在就跳过。
--
-- 回滚：
--   ALTER TABLE `qnh_refund_order`
--     DROP COLUMN `remark`, DROP COLUMN `remark_by`, DROP COLUMN `remark_at`;
--   （老代码不读这三列，回滚后只是备注列消失，退单列表其它字段不受影响）
-- ============================================================================

SET @db := DATABASE();

-- ── 1. remark：人工备注 ─────────────────────────────────────────────────────
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'qnh_refund_order' AND COLUMN_NAME = 'remark') = 0,
  'ALTER TABLE `qnh_refund_order` ADD COLUMN `remark` VARCHAR(512) DEFAULT NULL COMMENT ''人工备注（退单列表可编辑，同步不覆盖）'' AFTER `refund_reason`',
  'SELECT ''qnh_refund_order.remark 已存在，跳过'' AS skip_msg');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 2. remark_by：最后编辑人 ────────────────────────────────────────────────
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'qnh_refund_order' AND COLUMN_NAME = 'remark_by') = 0,
  'ALTER TABLE `qnh_refund_order` ADD COLUMN `remark_by` VARCHAR(64) DEFAULT NULL COMMENT ''备注最后编辑人（登录账号）'' AFTER `remark`',
  'SELECT ''qnh_refund_order.remark_by 已存在，跳过'' AS skip_msg');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 3. remark_at：最后编辑时间 ──────────────────────────────────────────────
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'qnh_refund_order' AND COLUMN_NAME = 'remark_at') = 0,
  'ALTER TABLE `qnh_refund_order` ADD COLUMN `remark_at` DATETIME DEFAULT NULL COMMENT ''备注最后编辑时间'' AFTER `remark_by`',
  'SELECT ''qnh_refund_order.remark_at 已存在，跳过'' AS skip_msg');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 4. 自检（可选）──────────────────────────────────────────────────────────
-- SELECT COUNT(*) AS total, SUM(remark IS NOT NULL AND remark <> '') AS with_remark
--   FROM qnh_refund_order;
