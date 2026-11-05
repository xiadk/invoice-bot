-- ═══════════════════════════════════════════════════════════════════════════
-- v0.3.39 拼多多人工催收：查询性能优化
--
-- 【为什么需要】
--   人工催收列表按商家聚合「交易成功(order_status=4) + 暂不可开票(0)/未同步开票(9)」的订单。
--   原实现每行用 JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.mall.mall_name')) 现解析店铺名，
--   而 raw_json 是 longtext（真实库平均 6 KB，存在溢出页），等于为了一个名字把整条订单
--   原始报文读出来再解析。
--
--   实测（3 万单、其中 4500 单命中口径、raw_json 平均 5.2 KB）：
--     原写法（JSON_EXTRACT）        279 ms
--     同查询但不取店铺名             73 ms   ← JSON 解析占了 74%
--     店铺名落列后                    85 ms
--   同时 EXPLAIN 显示走的是全表扫描 + filesort，没有专门的组合索引。
--
-- 【本脚本做三件事】
--   1) pdd_order 增加 mall_name 列（店铺名快照，下单/同步时写入）；
--   2) 增加组合索引 idx_pdo_collect (user_id, order_status, invoice_status, order_time)；
--   3) 回填存量店铺名（只补 NULL，反复执行安全）。
--
-- 【执行】
--   mysql -u<user> -p <db> < sql/upgrade/0.3.39-人工催收查询优化.sql
--   （重启服务也会由 db.js 的 migrate() 自动完成同样三件事，二者等效）
--
-- 【幂等】
--   加列/加索引都先查 information_schema 再执行，重复跑不会报错；
--   回填只更新 mall_name 为空的 3 万行（LIMIT），剩余部分下次执行继续补。
--
-- 【回滚】
--   ALTER TABLE `pdd_order` DROP INDEX `idx_pdo_collect`;
--   ALTER TABLE `pdd_order` DROP COLUMN `mall_name`;
--   旧代码不认识 mall_name 列，去掉不影响任何历史数据。
-- ═══════════════════════════════════════════════════════════════════════════

-- 1) 店铺名列
SET @has_col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pdd_order' AND COLUMN_NAME = 'mall_name'
);
SET @sql := IF(@has_col = 0,
  "ALTER TABLE `pdd_order` ADD COLUMN `mall_name` VARCHAR(128) DEFAULT NULL COMMENT '店铺名（下单时快照，人工催收按它分组展示）' AFTER `mall_sn`",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- 2) 组合索引
SET @has_idx := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pdd_order' AND INDEX_NAME = 'idx_pdo_collect'
);
SET @sql := IF(@has_idx = 0,
  'ALTER TABLE `pdd_order` ADD KEY `idx_pdo_collect` (`user_id`,`order_status`,`invoice_status`,`order_time`)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- 3) 回填存量店铺名（LIKE 前置让不匹配的行不必解析 JSON；30 万行以内一次跑完）
UPDATE `pdd_order`
   SET `mall_name` = LEFT(JSON_UNQUOTE(JSON_EXTRACT(`raw_json`, '$.mall.mall_name')), 128)
 WHERE `mall_name` IS NULL
   AND `raw_json` LIKE '%mall_name%'
 LIMIT 300000;

-- 自检：应能看到 mall_name 已填、索引已建
-- SELECT COUNT(*) AS 总单数, SUM(mall_name IS NOT NULL) AS 有店铺名的 FROM pdd_order;
-- SHOW INDEX FROM pdd_order WHERE Key_name = 'idx_pdo_collect';
