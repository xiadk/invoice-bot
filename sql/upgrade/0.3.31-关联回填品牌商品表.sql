-- ═══════════════════════════════════════════════════════════════════════════
-- v0.3.31 关联列回填：product_item → brand_product
--
-- 【为什么需要】
--   关联齐货通 / 阿发 / 京东商品时，若该 SKU 还没被「商品同步」写进 brand_product，
--   writeProductLink 会回退写进个人补货行 product_item。之后商品同步把 SKU 补进了
--   品牌表，却不会补关联列 → 同一个 SKU：
--     · 批次视图（导入补货参考文件 → 去补货）：COALESCE 读得到个人行的关联 → 有价；
--     · 品牌视图（补货页直接查询）：只读 brand_product → 关联为空 → 已关联却不显示。
--   v0.3.31 起读取口径改为「品牌行优先」（bp 有值即权威，个人行只在 SKU 不在品牌表时兜底），
--   本脚本把个人行里的历史值一次性补到品牌行，让两个视图读数一致。
--
-- 【执行】
--   mysql -u<user> -p <db> < sql/upgrade/0.3.31-关联回填品牌商品表.sql
--   （db.js migrate() 里已内置同一套幂等回填，重启服务会自动执行一遍，二者等效）
--
-- 【幂等】
--   每条都是「品牌行为空才填」，跑多少次结果一样；品牌行已有值一律不覆盖。
--   子查询按 brand_id+sku 聚合（MAX），同 SKU 多用户/多批次时取一个确定值，避免 JOIN 随机行。
--
-- 【回滚】
--   纯数据回填，无结构变更；如需回滚只能从备份恢复 brand_product 表
--   （建议执行前先备份：mysqldump <db> brand_product > brand_product.bak.sql）。
-- ═══════════════════════════════════════════════════════════════════════════

-- ① 齐货通商品关联
UPDATE brand_product bp
JOIN (SELECT brand_id, sku, MAX(NULLIF(qht_goods_id, '')) AS v
        FROM product_item GROUP BY brand_id, sku) m
  ON m.brand_id = bp.brand_id AND m.sku = bp.sku
   SET bp.qht_goods_id = m.v
 WHERE (bp.qht_goods_id IS NULL OR bp.qht_goods_id = '') AND m.v IS NOT NULL;

-- ② 阿发（永源顺）商品关联
UPDATE brand_product bp
JOIN (SELECT brand_id, sku, MAX(NULLIF(afa_goods_id, '')) AS v
        FROM product_item GROUP BY brand_id, sku) m
  ON m.brand_id = bp.brand_id AND m.sku = bp.sku
   SET bp.afa_goods_id = m.v
 WHERE (bp.afa_goods_id IS NULL OR bp.afa_goods_id = '') AND m.v IS NOT NULL;

-- ③ 京东万商 skuId 关联
UPDATE brand_product bp
JOIN (SELECT brand_id, sku, MAX(NULLIF(jd_sku_id, '')) AS v
        FROM product_item GROUP BY brand_id, sku) m
  ON m.brand_id = bp.brand_id AND m.sku = bp.sku
   SET bp.jd_sku_id = m.v
 WHERE (bp.jd_sku_id IS NULL OR bp.jd_sku_id = '') AND m.v IS NOT NULL;

-- ④ 本地价三件套 + 本地价供应商（供应商列 NOT NULL DEFAULT 0，0 视为未填）
UPDATE brand_product bp
JOIN (SELECT brand_id, sku,
             MAX(local_price) AS lp, MAX(local_pack_price) AS lpp,
             MAX(local_spec_qty) AS lsq, MAX(NULLIF(local_supplier_id, 0)) AS lsup
        FROM product_item GROUP BY brand_id, sku) m
  ON m.brand_id = bp.brand_id AND m.sku = bp.sku
   SET bp.local_price      = COALESCE(bp.local_price, m.lp),
       bp.local_pack_price = COALESCE(bp.local_pack_price, m.lpp),
       bp.local_spec_qty   = COALESCE(bp.local_spec_qty, m.lsq),
       bp.local_supplier_id= COALESCE(NULLIF(bp.local_supplier_id, 0), m.lsup, 0)
 WHERE m.lp IS NOT NULL OR m.lpp IS NOT NULL OR m.lsq IS NOT NULL OR m.lsup IS NOT NULL;
