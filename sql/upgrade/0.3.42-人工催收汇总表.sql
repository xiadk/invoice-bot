-- ============================================================================
-- 0.3.42 拼多多人工催收汇总表
--
-- 背景：催收列表原来一次性把命中订单全读出来、在 Node 里分组后整体返回（含每家订单明细）。
--       真实库 153 单约 20ms、73KB；数据量涨到几千单后请求会明显变慢。
--
-- 改法：同步时把商家维度的汇总落到本表，列表直接 ORDER BY amount LIMIT/OFFSET 分页；
--       订单明细改成点「详情」时按商家单查。表的创建已由 db.js 的幂等建表覆盖
--       （ensureQnhSchema 每次启动都会跑），本脚本供手工升级 / 审计用，可重复执行。
-- ============================================================================

CREATE TABLE IF NOT EXISTS `pdd_collect_summary` (
  `user_id`           INT           NOT NULL DEFAULT 1  COMMENT '数据归属用户',
  `collect_key`       VARCHAR(64)   NOT NULL            COMMENT '商家分组键（m<mall_id> / n<店铺名哈希> / s<mall_sn>）',
  `mall_id`           BIGINT        DEFAULT NULL        COMMENT '店铺 ID（能解析到才有）',
  `mall_sn`           VARCHAR(128)  DEFAULT NULL        COMMENT '店铺加密串',
  `mall_name`         VARCHAR(128)  DEFAULT NULL        COMMENT '店铺名快照',
  `order_count`       INT           NOT NULL DEFAULT 0  COMMENT '待人工催收订单数',
  `amount`            DECIMAL(14,2) NOT NULL DEFAULT 0.00 COMMENT '实付金额合计（元）',
  `missing_amount`    INT           NOT NULL DEFAULT 0  COMMENT '缺实付金额的订单数',
  `latest_order_sn`   VARCHAR(64)   DEFAULT NULL        COMMENT '最近一笔订单号',
  `latest_order_time` DATETIME      DEFAULT NULL        COMMENT '最近一笔下单时间',
  `sn_text`           TEXT                              COMMENT '该商家全部订单号（逗号分隔，供列表按订单号搜索）',
  `updated_at`        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`user_id`, `collect_key`),
  KEY `idx_pdcs_amount` (`user_id`, `amount`),
  KEY `idx_pdcs_name`   (`user_id`, `mall_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='拼多多人工催收汇总（商家维度，同步后重建；列表分页直接查它）';

-- 说明：历史数据不需要写 SQL 回填。
-- 汇总行需要按「mall_id → 店铺名哈希 → mall_sn」的 JS 分组规则生成（SQL 里算不出 FNV-1a），
-- 所以由服务启动后的首次列表访问 / 下一次同步触发 rebuildCollectSummary() 自动补齐。
