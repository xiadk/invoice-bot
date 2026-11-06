-- ═══════════════════════════════════════════════════════════════════════
-- 清理「采用补货建议」旧逻辑自动创建的假供应商「本地价」（v0.3.44）
--
-- 背景：v0.3.44 之前，本地价为最低价且没选供应商时，生成补货单会
--   ensureSupplier('本地价') 往 supplier 表里拉一条名叫「本地价」的假供应商。
--   实测存在 id=35、36 两条，并有 2 张补货单挂在它们名下。
-- 现在代码已在生成侧修掉（没供应商的本地价统一归「未指定供应商」，不再建行）。
--
-- ⚠ 本脚本自动执行「保洁」之前请先人工过一遍下面那条 SELECT，
--   确认这几张补货单确实该归「未指定供应商」而不是某个真实供应商：
--      SELECT id, supplier_id, supplier_name, amount, created_at
--        FROM replenish_order
--       WHERE supplier_name = '本地价'
--          OR supplier_id IN (SELECT id FROM supplier WHERE name = '本地价');
--   若要改归某个真实供应商，请直接把 0/「未指定供应商」替换成那家供应商的 id/name，
--   不要跑下面的删除语句（删除会把供应商从台账里抹掉）。
--
-- 两个动作：① 先把挂到假供应商的补货单改挂空；② 再删掉不再被引用的假供应商行。
-- ═══════════════════════════════════════════════════════════════════════

-- ① 把「本地价」假供应商名下（supplier_name 或 supplier_id）的补货单改挂空
UPDATE replenish_order o
   SET o.supplier_name = '未指定供应商', o.supplier_id = 0
 WHERE o.deleted_at IS NULL
   AND (o.supplier_name = '本地价'
        OR o.supplier_id IN (SELECT id FROM supplier WHERE name = '本地价'));

-- ② 删掉不再被任何补货单引用的假供应商「本地价」
DELETE FROM supplier
 WHERE name = '本地价'
   AND NOT EXISTS (SELECT 1 FROM replenish_order o WHERE o.supplier_id = supplier.id);

-- 校验（应返回 0 行 / 0 条）：
--   SELECT * FROM supplier WHERE name = '本地价';
--   SELECT * FROM replenish_order WHERE supplier_name = '本地价';
