-- ----------------------------------------------------------------------------
-- v0.3.7 货单历史数据修正（用户 2026-11-03 补充信息）
--
-- 背景：v0.3.6 导入「进货单留存.xlsx」时有三处待人工确认，用户已答复：
--   1) 零散进货!r42（2026-05-19，#VALUE! 金额）→ 金额 204.00，供应商 仟仟闪购
--   2) 零散进货!r125（2026-10-29，金额空）    → 金额 419.80，供应商 广州同超贸易有限公司
--      （该行 Excel 已写渠道，只是金额没填）
--   3) 4 张「零散进货（渠道待补）」单的渠道：
--        2026-05-19 (r44) → 仟仟闪购
--        2026-09-29 (r101) / 2026-10-08 (r111) / 2026-10-19 (r117) → 农夫山泉
--   4) 历史货单开票状态统一改为「已开票」（invoice_status = 1）
--   5) 「零散进货（渠道待补）」供应商在无人引用后删除
--
-- 归属账号：user_id = 4（中山仕赫贸易有限公司）
--
-- 执行：mysql -u<user> -p<pwd> <db> < sql/upgrade/0.3.7-货单历史数据修正.sql
--       幂等：货单按 note 判重、供应商按 (user_id,name) 唯一键合并、渠道更新按 note 定位，
--             重复执行不会插两条，也不会把已改好的渠道再改错
--
-- 回滚（把渠道改回待补、删掉新增两单；开票状态不回滚）：
--   DELETE FROM waybill WHERE user_id = 4 AND note IN ('Excel导入 零散进货!r42','Excel导入 零散进货!r125');
--   UPDATE waybill w JOIN supplier s ON s.id = w.supplier_id
--      SET w.supplier_id = (SELECT id FROM supplier WHERE user_id = 4 AND name = '零散进货（渠道待补）')
--    WHERE w.user_id = 4 AND w.note IN ('Excel导入 零散进货!r44','Excel导入 零散进货!r101',
--                                       'Excel导入 零散进货!r111','Excel导入 零散进货!r117');
-- ----------------------------------------------------------------------------

SET NAMES utf8mb4;

-- ── 1. 补齐供应商：农夫山泉（仟仟闪购 / 广州同超 已存在）────────────────
INSERT INTO `supplier` (`user_id`, `name`, `note`, `created_by`) VALUES
  (4, '农夫山泉', '历史货单导入', 'admin')
ON DUPLICATE KEY UPDATE `name` = VALUES(`name`);

-- ── 2. 补两条漏掉的货单（r42 金额 204，r125 金额 419.8）──────────────
INSERT INTO `waybill` (`user_id`, `supplier_id`, `supplier_name`, `amount`, `bill_date`,
                       `invoice_status`, `note`, `created_by`)
SELECT 4, sp.`id`, sp.`name`, t.`amount`, t.`bill_date`, 1, t.`note`, 'admin'
  FROM (
        SELECT '仟仟闪购'              AS `sup`, 204.00 AS `amount`, '2026-05-19' AS `bill_date`, 'Excel导入 零散进货!r42'  AS `note`
  UNION ALL
        SELECT '广州同超贸易有限公司'  AS `sup`, 419.80 AS `amount`, '2026-10-29' AS `bill_date`, 'Excel导入 零散进货!r125' AS `note`
       ) t
  JOIN `supplier` sp ON sp.`user_id` = 4 AND sp.`name` = t.`sup`
 WHERE NOT EXISTS (SELECT 1 FROM `waybill` w WHERE w.`user_id` = 4 AND w.`note` = t.`note`);

-- ── 3. 4 张待补单改到正确供应商 ────────────────────────────────────────
--    2026-05-19 那张 → 仟仟闪购
UPDATE `waybill` w
  JOIN `supplier` sp ON sp.`user_id` = 4 AND sp.`name` = '仟仟闪购'
   SET w.`supplier_id` = sp.`id`, w.`supplier_name` = sp.`name`
 WHERE w.`user_id` = 4 AND w.`note` = 'Excel导入 零散进货!r44';

--    其余三张 → 农夫山泉
UPDATE `waybill` w
  JOIN `supplier` sp ON sp.`user_id` = 4 AND sp.`name` = '农夫山泉'
   SET w.`supplier_id` = sp.`id`, w.`supplier_name` = sp.`name`
 WHERE w.`user_id` = 4
   AND w.`note` IN ('Excel导入 零散进货!r101', 'Excel导入 零散进货!r111', 'Excel导入 零散进货!r117');

-- ── 4. 历史货单开票状态统一改为「已开票」──────────────────────────────
UPDATE `waybill` SET `invoice_status` = 1 WHERE `user_id` = 4 AND `deleted_at` IS NULL;

-- ── 5. 清掉已无人引用的「零散进货（渠道待补）」供应商 ──────────────────
DELETE s FROM `supplier` s
 WHERE s.`user_id` = 4
   AND s.`name` = '零散进货（渠道待补）'
   AND NOT EXISTS (SELECT 1 FROM `waybill` w WHERE w.`supplier_id` = s.`id` AND w.`user_id` = s.`user_id`);

-- ── 6. 核对（跑完看这里：357 张、合计 822756.23、已开票 357）────────────
SELECT COALESCE(s.`name`, w.`supplier_name`) AS 供应商,
       COUNT(*)        AS 货单数,
       SUM(w.`amount`) AS 金额合计,
       SUM(w.`invoice_status` = 1) AS 已开票数
  FROM `waybill` w
  LEFT JOIN `supplier` s ON s.`id` = w.`supplier_id` AND s.`user_id` = w.`user_id`
 WHERE w.`user_id` = 4 AND w.`note` LIKE 'Excel导入%' AND w.`deleted_at` IS NULL
 GROUP BY 1 ORDER BY 3 DESC;
